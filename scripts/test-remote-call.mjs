#!/usr/bin/env node
/**
 * Step 4 自测：真机端到端 —— ChatGPT 侧的 `tools/call` 要真的在远程机器上执行。
 *
 *   node scripts/test-remote-call.mjs [baseUrl]
 *
 * 前置：`npm run dev` 已在跑，且至少一台设备在线
 *       （`MCP_SERVER_URL=http://localhost:8787 npx @wonderwhy-er/desktop-commander@latest remote`）。
 *
 * 覆盖：
 *   1  OAuth 拿 token（DCR → authorize → token）
 *   2  list_devices 至少一台 online
 *   3  ping             → 设备回 pong（门铃 + 认领 + 写回 全链路）
 *   4  get_usage_stats  → 设备上的真实工具执行结果
 *   5  read_file        → 真实文件内容
 *   6  不存在的工具名    → 设备侧报错被还原成 isError
 *   7  _meta.device_id  → 定向投递：不存在的设备要立刻报错，不等 4 分钟
 *   8  全程耗时          → ping 不该等到超时
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const PASSWORD = process.env.AUTH_PASSWORD ?? "Relay-DCM-2026";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✔ ${label}`);
  } else {
    fail++;
    console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}
const b64url = (b) => b.toString("base64url");
const s256 = (v) => b64url(createHash("sha256").update(v).digest());
const origin = new URL(BASE).origin;

// --- 1. OAuth ---------------------------------------------------------------
section(1, "拿一个 ChatGPT 用的 access_token");
const regRes = await fetch(`${origin}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: "rdc-step4-test",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const clientId = (await regRes.json().catch(() => null))?.client_id;
check(`DCR 拿到 client_id (status ${regRes.status})`, Boolean(clientId), String(clientId));

const verifier = b64url(randomBytes(32));
const authQuery = new URLSearchParams({
  response_type: "code",
  client_id: clientId ?? "",
  redirect_uri: REDIRECT_URI,
  scope: "mcp:tools desktop:auth",
  state: b64url(randomBytes(16)),
  code_challenge: s256(verifier),
  code_challenge_method: "S256",
  resource: origin,
});
const authPost = await fetch(`${origin}/authorize?${authQuery}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD }).toString(),
  redirect: "manual",
});
const code = new URL(authPost.headers.get("location") ?? `${origin}/?x=1`).searchParams.get("code");
check(`authorize → code (status ${authPost.status})`, Boolean(code), authPost.headers.get("location") ?? "");

const tokenRes = await fetch(`${origin}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: REDIRECT_URI,
    client_id: clientId ?? "",
    code_verifier: verifier,
  }).toString(),
});
const accessToken = (await tokenRes.json().catch(() => null))?.access_token;
check(`token (status ${tokenRes.status})`, Boolean(accessToken));

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${accessToken}`,
};

async function rpc(id, method, params) {
  const t0 = Date.now();
  const r = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const raw = await r.text();
  return { status: r.status, raw, body: parseBody(raw), ms: Date.now() - t0 };
}

await rpc(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "rdc-step4-test", version: "0.0.1" },
});

async function callTool(name, args = {}, meta) {
  const params = { name, arguments: args };
  if (meta) params._meta = meta;
  return rpc(10, "tools/call", params);
}
const textOf = (r) => r.body?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";

// --- 2. 设备在线 ------------------------------------------------------------
section(2, "设备在线");
const listRes = await callTool("list_devices");
const devices = JSON.parse(textOf(listRes) || "{}").devices ?? [];
const online = devices.filter((d) => d.status === "online");
console.log(`    设备：${devices.map((d) => `${d.device_name}=${d.status}`).join(", ") || "（无）"}`);
check(`至少一台 online（实际 ${online.length}）`, online.length > 0, "先启动设备进程");
if (!online.length) {
  console.log("\n没有在线设备，后续用例无法验证。启动设备后重跑。");
  process.exit(1);
}
const target = online[0];

// --- 3. ping ----------------------------------------------------------------
section(3, "ping（门铃 → 认领 → 执行 → 写回 全链路）");
const ping = await callTool("ping");
check(`ping 200 (实际 ${ping.status}, ${ping.ms}ms)`, ping.status === 200, ping.raw.slice(0, 300));
check(`ping 非 isError`, ping.body?.result?.isError !== true, textOf(ping).slice(0, 300));
check(`ping 回了 pong`, /pong/.test(textOf(ping)), textOf(ping).slice(0, 300));
check(`ping 快于超时 (${ping.ms}ms < 20000ms)`, ping.ms < 20_000, `${ping.ms}ms`);

// --- 4. 真实工具 ------------------------------------------------------------
section(4, "get_usage_stats（设备上的真实执行）");
const stats = await callTool("get_usage_stats");
check(`200 (实际 ${stats.status}, ${stats.ms}ms)`, stats.status === 200, stats.raw.slice(0, 300));
check(`非 isError`, stats.body?.result?.isError !== true, textOf(stats).slice(0, 400));
check(`有真实输出`, textOf(stats).length > 0, textOf(stats).slice(0, 200));

// --- 5. 读文件 --------------------------------------------------------------
section(5, "read_file（真实文件内容）");
const file = await callTool("read_file", { path: "/etc/hosts" });
check(`200 (实际 ${file.status}, ${file.ms}ms)`, file.status === 200, file.raw.slice(0, 300));
check(`非 isError`, file.body?.result?.isError !== true, textOf(file).slice(0, 400));
check(`读到了 localhost`, /localhost/.test(textOf(file)), textOf(file).slice(0, 300));

// --- 6. 失败传播 ------------------------------------------------------------
section(6, "不存在的工具名 → isError");
const bad = await callTool("definitely_not_a_tool", {});
check(`200 (实际 ${bad.status})`, bad.status === 200, bad.raw.slice(0, 300));
const badText = textOf(bad);
check(
  `失败被还原成 isError`,
  bad.body?.result?.isError === true || /unknown|not found|no such|不存在/i.test(badText),
  badText.slice(0, 300),
);

// --- 7. 定向投递 ------------------------------------------------------------
section(7, "_meta.device_id 定向投递");
const bogusId = crypto.randomUUID();
const routed = await callTool("ping", {}, { device_id: bogusId });
check(`200 (实际 ${routed.status})`, routed.status === 200, routed.raw.slice(0, 300));
check(`不存在的设备立刻报错 (isError)`, routed.body?.result?.isError === true, textOf(routed).slice(0, 300));
check(`错误说明了设备不在线`, /在线|online/.test(textOf(routed)), textOf(routed).slice(0, 300));
check(`不等超时 (${routed.ms}ms < 5000ms)`, routed.ms < 5_000, `${routed.ms}ms`);

const routedOk = await callTool("ping", {}, { device_id: target.id });
check(`正确的设备_id 能跑通`, /pong/.test(textOf(routedOk)), textOf(routedOk).slice(0, 300));

// --- 8. 长任务（子请求预算回归）----------------------------------------------
// Workers Free 单次请求只有 **50 个子请求**（官方 limits 页，KV 读写也算）。
// 固定 500ms 轮询时约 20~40s 就撞墙，报
// `Too many subrequests by single Worker invocation`（真机复现过：一次 read_file
// 因设备侧偶发变慢拖到 39s 直接翻车）。
//
// 用 start_process 卡住：它会**阻塞等初始输出**，`sleep 30 && echo ...` 让这一次
// 调用真实地挂 30s+ —— 自适应退避下约 18 次轮询就能扛过去，老代码要 ~70 次。
// 标记用 `echo MAR""KER_OK_7f3a`：回显的输入行里没有连起来的字面量，只有 sleep
// 之后真正打印出来的输出才有 —— 防假阳性。
section(8, "长任务：设备端挂 30s（子请求预算回归）");

const slow = await callTool("start_process", {
  command: 'sleep 30 && echo MAR""KER_OK_7f3a',
  timeout_ms: 120_000,
});
check(`200 (实际 ${slow.status})`, slow.status === 200, slow.raw.slice(0, 300));
check(`扛过子请求预算（${slow.ms}ms ≥ 25000）`, slow.ms >= 25_000, `${slow.ms}ms`);
check(
  `不是 Too many subrequests`,
  !/Too many subrequests/i.test(textOf(slow)) && slow.body?.result?.isError !== true,
  textOf(slow).slice(0, 300),
);
check(`拿到延迟输出（非回显）`, /MARKER_OK_7f3a/.test(textOf(slow)), textOf(slow).slice(0, 300));
check(`拿到 pid`, /PID \d+/.test(textOf(slow)), textOf(slow).slice(0, 300));

// --- 汇总 ---------------------------------------------------------------------
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function parseBody(text) {
  if (!text) return null;
  if (text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
    const joined = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    try {
      return JSON.parse(joined);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
