/**
 * Step 4 — 云端 → 设备 的核心链路（README §4「时序 B」）。
 *
 *   1. 挑一台在线设备（`mcp_devices`，按 last_seen 倒序）
 *   2. INSERT `mcp_remote_calls`（status=pending，timeout_at 由 DB 时钟给）
 *   3. 广播门铃 `new_call` 到私有频道 `user:{user_id}`（载荷**只有** call_id / device_id）
 *   4. 轮询该行到终态，或等到超时
 *   5. 把设备写回的 `CallToolResult` 原样交还 ChatGPT
 *
 * 执行语义完全在设备侧（`npx @wonderwhy-er/desktop-commander remote`）：
 * 条件 UPDATE `pending -> executing` 保证 exactly-once，本地执行完写回
 * `completed/failed`。本文件只负责投递与等待，不碰执行。
 *
 * 失败即返回 `isError` 结果（不是 JSON-RPC error）——按 MCP 规范，工具执行
 * 失败要让模型读到文字原因，而不是让它以为协议出错。
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Env } from "./env.js";
import {
  getRemoteCall,
  insertRemoteCall,
  issueSession,
  listDevices,
  purgeRemoteCalls,
} from "./supabase.js";

/** 等待上限：DB 的 `timeout_at` 是 +5min，这里留 60s 余量。实际更早受轮询预算限制。 */
const MAX_WAIT_MS = 240_000;
/** 连续轮询失败几次才认为 REST 挂了（偶发抖动不该让调用失败）。 */
const POLL_ERROR_STRIKES = 5;
/** 清扫节流：同一 isolate 内最多每 10 分钟跑一次。 */
const PURGE_INTERVAL_MS = 600_000;

let lastPurgeAt = 0;
/** GoTrue session 复用（password grant 每次都是一次往返）。 */
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function text(textValue: string): CallToolResult {
  return { content: [{ type: "text", text: textValue }] };
}

function error(textValue: string): CallToolResult {
  return { content: [{ type: "text", text: textValue }], isError: true };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Postgres 的 jsonb/text 都存不了 NUL（U+0000），客户端传个二进制串进来
 * 会让整条 INSERT 报 22P05。设备侧写回时做同样的事，这里写入时做。
 */
function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripNul(v);
    return out;
  }
  return value;
}

/** 挑一台在线设备；`wantedId` 来自 MCP `_meta.device_id`（可选的定向投递）。 */
async function pickDevice(env: Env, wantedId?: string): Promise<any> {
  const rows = await listDevices(env);
  if (!rows.length) {
    throw new Error(
      "还没有配对的设备。在目标机器上运行 `npx @wonderwhy-er/desktop-commander@latest remote` 完成配对。",
    );
  }
  const online = rows.filter((r: any) => r.status === "online");
  if (wantedId) {
    const hit = online.find((r: any) => r.id === wantedId);
    if (!hit) {
      throw new Error(
        `指定的设备 ${wantedId} 不在线。在线设备：${online.map((r: any) => r.id).join(", ") || "（无）"}`,
      );
    }
    return hit;
  }
  if (!online.length) {
    const roster = rows.map((r: any) => `${r.device_name}=${r.status}`).join(", ");
    throw new Error(`没有在线设备（${roster}）。确认目标机器上的 remote 进程还活着、网络可用。`);
  }
  return online[0];
}

async function userAccessToken(env: Env): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  const session = await issueSession(env);
  cachedAccessToken = {
    token: session.access_token,
    expiresAt: Date.now() + session.expires_in * 1000,
  };
  return session.access_token;
}

/**
 * 发门铃到私有频道 `user:{user_id}`。
 *
 * 实测（`scripts/probe-broadcast.mjs`）：
 *   - 只带 `apikey` → **202 但消息被静默丢弃**：私有频道写 `realtime.messages`
 *     要过 RLS `topic = 'user:' || auth.uid()`，没有用户 JWT 时 `auth.uid()` 为空，
 *     策略不放行，而接口照样回 202。
 *   - `apikey` + **用户**的 GoTrue JWT → 202 且设备真的收到、认领、执行。
 *
 * 所以这里没有「降级到只带 apikey」的分支——那条路只会让我们白等 4 分钟超时。
 * JWT 拿不到就直接报错，ChatGPT 立刻看到原因。
 */
async function broadcastNewCall(env: Env, callId: string, deviceId: string): Promise<void> {
  const accessToken = await userAccessToken(env);
  const res = await fetch(`${env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          topic: `user:${env.USER_ID}`,
          event: "new_call",
          payload: { call_id: callId, device_id: deviceId },
          private: true,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`广播 new_call 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * 轮询到终态；返回 null 表示等到超时（或行被清扫）。
 * 抛 `PollBudgetExhausted` 表示子请求预算用尽（见下）。
 *
 * **子请求预算是硬约束**：Workers Free 单次请求只给 **50 个子请求**（官方 limits 页，
 * KV 读写也算），而每次 `getRemoteCall` 就是一次 fetch，基础开销
 * （OAuth 的 KV 校验 / listDevices / insert / 广播 / GoTrue）还要占掉几个。
 * 原来固定 500ms 一轮 → 理论上 240s 要 480 次，**实际约 40~45 轮就撞墙**，
 * 报 `Too many subrequests by single Worker invocation`（真机复现过一次，
 * 一次 `read_file` 因设备侧偶发变慢拖到 39s 直接翻车）。
 *
 * 改法：**自适应退避 + 轮询预算**。头 3s 密集（快调用不掉延迟）、3~12s 放到 1s、
 * 之后 5s 一轮。34 轮预算在真机实测的每轮 ~0.8s（500ms 睡眠 + REST 往返）下
 * 能覆盖 **约 2 分钟**，而 HTTP 请求本身没有时长上限（官方 limits 页：只要客户端
 * 还连着，Worker 可以一直做子请求）。
 */
const POLL_BUDGET = 34;
const POLL_FAST_MS = 500;
const POLL_MED_MS = 1_000;
const POLL_SLOW_MS = 5_000;
const FAST_WINDOW_MS = 3_000;
const MED_WINDOW_MS = 12_000;

class PollBudgetExhausted extends Error {
  constructor(public readonly polls: number) {
    super(`subrequest budget exhausted after ${polls} polls`);
  }
}

function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < FAST_WINDOW_MS) return POLL_FAST_MS;
  if (elapsedMs < MED_WINDOW_MS) return POLL_MED_MS;
  return POLL_SLOW_MS;
}

async function waitForResult(env: Env, callId: string, deadline: number): Promise<any | null> {
  let strikes = 0;
  let polls = 0;
  const startedAt = Date.now();
  for (;;) {
    let row: any | null = null;
    let readFailed = false;
    try {
      row = await getRemoteCall(env, callId);
      strikes = 0;
    } catch (err) {
      if (++strikes >= POLL_ERROR_STRIKES) throw err;
      readFailed = true;
    }
    polls++; // 无论成败，这次 fetch 都消耗了一个子请求
    if (!readFailed) {
      if (!row) return null; // 被清扫了
      if (row.status === "completed" || row.status === "failed") return row;
      // pending / executing —— 继续等
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    if (polls >= POLL_BUDGET) throw new PollBudgetExhausted(polls);
    await sleep(Math.min(pollIntervalMs(Date.now() - startedAt), left));
  }
}

/** 把设备写回的 `result` 变成 MCP `CallToolResult`（设备端写的就是这个形状）。 */
function toResult(value: unknown): CallToolResult {
  if (value && typeof value === "object" && Array.isArray((value as any).content)) {
    return value as CallToolResult;
  }
  if (value === null || value === undefined) return text("(设备没有返回结果)");
  if (typeof value === "string") return text(value);
  try {
    return text(JSON.stringify(value, null, 2));
  } catch {
    return text(String(value));
  }
}

export interface DispatchOptions {
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** MCP 请求里的 `_meta`，设备端会原样并进本地调用的 `_meta`。 */
  metadata?: Record<string, unknown>;
  /** 可选定向投递：`_meta.device_id`。缺省用最近活跃的在线设备。 */
  deviceId?: string;
}

/** 投递一次远程工具调用并等它跑完。 */
export async function dispatchCall(env: Env, opts: DispatchOptions): Promise<CallToolResult> {
  const device = await pickDevice(env, opts.deviceId);

  // 清扫老行（Worker 没挂 cron 时的兜底），节流且失败不影响主流程。
  if (Date.now() - lastPurgeAt > PURGE_INTERVAL_MS) {
    lastPurgeAt = Date.now();
    await purgeRemoteCalls(env);
  }

  const callId = crypto.randomUUID();
  const row = await insertRemoteCall(env, {
    id: callId,
    user_id: env.USER_ID,
    device_id: device.id,
    tool_name: opts.toolName,
    tool_args: stripNul(opts.toolArgs ?? {}),
    metadata: stripNul(opts.metadata ?? {}),
    status: "pending",
    timeout_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });

  try {
    await broadcastNewCall(env, callId, device.id);
  } catch (err) {
    return error(
      `${opts.toolName}：门铃广播失败，设备 ${device.device_name} 收不到这次调用。${reason(err)}`,
    );
  }

  const startedAt = Date.now();
  const timeoutAt = Date.parse(row?.timeout_at ?? "") || startedAt + 5 * 60_000;
  const deadline = Math.min(startedAt + MAX_WAIT_MS, timeoutAt);

  let done: any | null = null;
  try {
    done = await waitForResult(env, callId, deadline);
  } catch (err) {
    if (err instanceof PollBudgetExhausted) {
      return error(
        `${opts.toolName}：已投递给设备 ${device.device_name}，但等待预算用尽（${err.polls} 次轮询）。` +
          "Cloudflare Workers 免费版单次请求只允许 50 个子请求，这是硬上限。" +
          "调用可能仍在设备上执行，结果会照常写入 mcp_remote_calls，稍后可在控制台/DB 查到。",
      );
    }
    if (/Too many subrequests/i.test(reason(err))) {
      return error(
        `${opts.toolName}：子请求配额被打满（${reason(err)}）。` +
          `调用已投递给设备 ${device.device_name}，可能仍在执行，结果会照常写入 mcp_remote_calls。`,
      );
    }
    return error(`${opts.toolName}：轮询执行结果失败（${reason(err)}）。调用已投递给设备 ${device.device_name}，可能仍在执行。`);
  }

  if (!done) {
    return error(
      `${opts.toolName}：等待设备 ${device.device_name} 执行超时（上限 ${Math.round(
        (deadline - startedAt) / 1000,
      )}s，已等 ${Math.round((Date.now() - startedAt) / 1000)}s）。` +
        "设备可能在执行长任务、中途失联，或错过了门铃。",
    );
  }
  if (done.status === "failed") {
    // 假阴性：设备端 remote-channel.ts 的 fail-fast 兜底，在「结果写入的 UPDATE
    // 已提交、但 HTTP 响应在半路丢失」时会误判成写入失败（实测
    // `TypeError: fetch failed`，设备经本地代理连 Supabase 时出现过），
    // 再补一发把 status 改写成 `failed` —— 而 `result` 其实安然在库里。
    // 兜底那一发传的是 `result: null`，且 `if (result !== null)` 不会清掉旧值，
    // 所以这个组合在正确执行下不可能出现。
    //
    // 对照真正在跑的 npm 包 `@wonderwhy-er/desktop-commander` 的 dist：
    //   成功       → updateCallResult(id, 'completed', result)
    //   真执行失败 → updateCallResult(id, 'failed', null, error.message)
    // 即「failed 且有 result」**只**可能是这个假阴性 → 以 result 为准。
    if (hasResult(done.result)) return toResult(done.result);
    return error(`${opts.toolName} 在设备 ${device.device_name} 上执行失败：${done.error_message ?? "未知错误"}`);
  }
  return toResult(done.result);
}

/** jsonb 里可能是 JSON `""` —— 那不算有结果。 */
function hasResult(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}
