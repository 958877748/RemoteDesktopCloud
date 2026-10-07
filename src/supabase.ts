/**
 * Supabase REST / GoTrue 的最小封装（只用 fetch，不引 sdk）。
 * 服务端一律 service_role，绕过 RLS。
 */
import type { Env } from "./env.js";

export class SupabaseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function rest(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new SupabaseError(`REST ${path} ${res.status}: ${text.slice(0, 300)}`, res.status);
  return text ? JSON.parse(text) : null;
}

export async function insertDeviceCode(env: Env, row: Record<string, unknown>): Promise<void> {
  await rest(env, "mcp_device_codes", { method: "POST", body: JSON.stringify(row) });
}

export async function getDeviceCode(env: Env, deviceCode: string): Promise<any | null> {
  const rows = (await rest(
    env,
    `mcp_device_codes?device_code=eq.${encodeURIComponent(deviceCode)}&select=*`,
  )) as any[];
  return rows[0] ?? null;
}

export async function approveDeviceCode(env: Env, userCode: string, deviceId: string): Promise<boolean> {
  const rows = (await rest(
    env,
    `mcp_device_codes?user_code=eq.${encodeURIComponent(userCode)}&status=eq.pending&expires_at=gt.${new Date().toISOString()}&select=device_code`,
  )) as any[];
  if (!rows.length) return false;
  await rest(env, `mcp_device_codes?device_code=eq.${encodeURIComponent(rows[0].device_code)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "approved", approved_device_id: deviceId }),
  });
  return true;
}

export async function deleteDeviceCode(env: Env, deviceCode: string): Promise<void> {
  await rest(env, `mcp_device_codes?device_code=eq.${encodeURIComponent(deviceCode)}`, { method: "DELETE" });
}

export async function purgeExpiredCodes(env: Env): Promise<void> {
  await rest(env, `mcp_device_codes?expires_at=lt.${new Date(Date.now() - 3600_000).toISOString()}`, {
    method: "DELETE",
  }).catch(() => void 0);
}

export async function findDevice(env: Env, deviceId: string): Promise<any | null> {
  const rows = (await rest(
    env,
    `mcp_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${env.USER_ID}&select=id`,
  )) as any[];
  return rows[0] ?? null;
}

/** 服务端代建设备行（设备端 registerDevice 只查不建）。返回 device id。 */
export async function createDevice(
  env: Env,
  args: { deviceId?: string; deviceName: string },
): Promise<string> {
  const body: Record<string, unknown> = {
    user_id: env.USER_ID,
    device_name: args.deviceName || "device",
    status: "offline",
    capabilities: {},
    last_seen: new Date().toISOString(),
  };
  if (args.deviceId) body.id = args.deviceId;
  const rows = (await rest(env, "mcp_devices", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  })) as any[];
  return rows[0].id;
}

/** 当前用户的全部设备（list_devices 工具用 / 控制台页面用）。 */
export async function listDevices(env: Env): Promise<any[]> {
  return (await rest(
    env,
    `mcp_devices?user_id=eq.${encodeURIComponent(env.USER_ID)}&select=id,device_name,status,last_seen,capabilities&order=last_seen.desc`,
  )) as any[];
}

/**
 * 吊销一台设备：删掉 `mcp_devices` 行。
 * `mcp_remote_calls.device_id` 是 `on delete cascade`，它的调用行一起消失，
 * 而新调用又插不进去（外键）→ 这台机器立刻从 ChatGPT 的可选目标里消失。
 */
export async function deleteDevice(env: Env, deviceId: string): Promise<void> {
  await rest(
    env,
    `mcp_devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(env.USER_ID)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// mcp_remote_calls：任务队列的投递侧（设备端负责认领与写回）
// ---------------------------------------------------------------------------

/**
 * 投递一次远程调用（`status=pending`）。返回 DB 落库后的整行——
 * `id` 由 Worker 生成（少一次往返的歧义），`timeout_at` 取 DB 时钟（设备端
 * 认领条件是 `timeout_at > now()`，必须以 DB 为准）。
 */
export async function insertRemoteCall(env: Env, row: Record<string, unknown>): Promise<any> {
  const rows = (await rest(env, "mcp_remote_calls", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  })) as any[];
  return rows[0];
}

/** 读一次调用行（轮询用）。返回 null 表示已被清扫。 */
export async function getRemoteCall(env: Env, callId: string): Promise<any | null> {
  const rows = (await rest(
    env,
    `mcp_remote_calls?id=eq.${encodeURIComponent(callId)}&select=id,status,result,error_message,timeout_at,completed_at`,
  )) as any[];
  return rows[0] ?? null;
}

/**
 * 清扫（等价于 `sweep_remote_calls()` 里跟调用表有关的两条）：
 * 终态 >1min 删除、创建 >1h 兜底删除。Worker 侧没有 cron 时靠它兜底，
 * 调用频率低（1 人 2-3 台设备），节流执行即可。
 */
export async function purgeRemoteCalls(env: Env): Promise<void> {
  const now = Date.now();
  await rest(env, `mcp_remote_calls?completed_at=lt.${new Date(now - 60_000).toISOString()}&status=in.(completed,failed)`, {
    method: "DELETE",
  }).catch(() => void 0);
  await rest(env, `mcp_remote_calls?created_at=lt.${new Date(now - 3600_000).toISOString()}`, {
    method: "DELETE",
  }).catch(() => void 0);
}

/** password grant：换 GoTrue 签发的真 session（设备端 setSession 依赖它）。 */
export async function issueSession(env: Env): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: env.USER_EMAIL, password: env.AUTH_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new SupabaseError(`GoTrue password grant ${res.status}: ${text.slice(0, 300)}`, res.status);
  const data = JSON.parse(text);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type ?? "bearer",
    expires_in: data.expires_in ?? 3600,
  };
}
