/**
 * Step 2 — 设备授权流（协议被 npx @wonderwhy-er/desktop-commander 锁死，不可改动）：
 *
 *   GET  /api/mcp-info      → { supabaseUrl, supabasePublishableKey }
 *   POST /device/start      → { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
 *   GET  /device/verify     → 密码 + 配对码页面（乙方案）
 *   POST /device/verify     → 校验 AUTH_PASSWORD，落 approved，确保 mcp_devices 行存在
 *   POST /device/poll       → pending: {error:'authorization_pending'} / 完成: GoTrue token + device_id
 */
import type { Env } from "./env.js";
import {
  approveDeviceCode,
  createDevice,
  deleteDeviceCode,
  findDevice,
  getDeviceCode,
  insertDeviceCode,
  issueSession,
  purgeExpiredCodes,
} from "./supabase.js";

const CODE_TTL_SECONDS = 600; // 10 分钟，客户端按 expires_in/interval 计算轮询次数
const POLL_INTERVAL = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混的 I/O/0/1

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
  return out;
}

function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readJson(request: Request): Promise<any> {
  return request.json().catch(() => ({}));
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return computed === challenge;
}

export async function handleMcpInfo(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  return json({
    supabaseUrl: env.SUPABASE_URL,
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    mcpServerUrl: origin,
    version: "0.1.0",
  });
}

export async function handleDeviceStart(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const codeChallenge = body.code_challenge;
  if (!codeChallenge || body.code_challenge_method !== "S256") {
    return json({ error: "invalid_request", error_description: "S256 code_challenge required" }, 400);
  }

  const origin = new URL(request.url).origin;
  const deviceCode = crypto.randomUUID() + "." + randomString(32);
  const userCode = formatUserCode(randomString(8));
  const now = Date.now();

  await purgeExpiredCodes(env);
  await insertDeviceCode(env, {
    device_code: deviceCode,
    user_code: userCode,
    client_id: body.client_id ?? "mcp-device",
    device_name: body.device_name ?? "device",
    device_type: body.device_type ?? "mcp",
    device_id: body.device_id ?? null,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    status: "pending",
    expires_at: new Date(now + CODE_TTL_SECONDS * 1000).toISOString(),
  });

  return json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/device/verify`,
    verification_uri_complete: `${origin}/device/verify?code=${userCode}`,
    expires_in: CODE_TTL_SECONDS,
    interval: POLL_INTERVAL,
  });
}

export async function handleDevicePoll(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const deviceCode = body.device_code;
  if (!deviceCode) return json({ error: "invalid_request", error_description: "device_code required" }, 400);

  const row = await getDeviceCode(env, deviceCode);
  if (!row) {
    return json({ error: "expired_token", error_description: "Unknown or expired device code" }, 400);
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    await deleteDeviceCode(env, deviceCode);
    return json({ error: "expired_token", error_description: "Device code expired" }, 400);
  }
  if (row.status === "pending") {
    return json({ error: "authorization_pending" }, 400);
  }
  if (row.status !== "approved") {
    return json({ error: "access_denied", error_description: "Authorization was denied" }, 400);
  }

  // PKCE：设备端 verifier 必须对上 start 时的 challenge
  if (!(await verifyPkce(body.code_verifier, row.code_challenge))) {
    return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  // 确保 mcp_devices 行存在：优先用 verify 阶段已建好并记在 approved_device_id 的行；
  // 若设备自带旧 id 且该行仍存在（未吊销）则沿用；两者都没有才新建。
  let deviceId: string;
  if (row.approved_device_id && (await findDevice(env, row.approved_device_id))) {
    deviceId = row.approved_device_id;
  } else if (row.device_id && (await findDevice(env, row.device_id))) {
    deviceId = row.device_id;
  } else {
    deviceId = await createDevice(env, { deviceId: row.device_id, deviceName: row.device_name });
  }

  const session = await issueSession(env);
  await deleteDeviceCode(env, deviceCode);

  return json({
    ...session,
    device_id: deviceId,
  });
}

// ---------------------------------------------------------------------------
// /device/verify — 浏览器页面（与 Step 3 的 /authorize 共用密码校验）
// ---------------------------------------------------------------------------

export function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d0d0d;color:#e8e8e8;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:12px;padding:32px;width:100%;max-width:380px}
  h1{font-size:18px;margin:0 0 20px}
  label{display:block;font-size:13px;color:#9a9a9a;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #3a3a3a;
        background:#0d0d0d;color:#e8e8e8;font-size:15px}
  input.code{letter-spacing:2px;text-transform:uppercase;font-family:ui-monospace,monospace}
  button{width:100%;margin-top:20px;padding:11px;border:none;border-radius:8px;background:#10a37f;color:#fff;
         font-size:15px;cursor:pointer}
  button:hover{background:#0e8f70}
  .ok{color:#10a37f;font-size:32px;margin-bottom:12px}
  .err{color:#ff6b6b;font-size:14px;margin-top:14px}
  p{font-size:14px;line-height:1.6;color:#9a9a9a}
</style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function handleDeviceVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const codeFromQuery = url.searchParams.get("code") ?? "";

  if (request.method === "GET") {
    return page(
      "验证设备",
      `<h1>连接这台电脑</h1>
<p>请确认浏览器地址旁显示的配对码与设备终端一致，然后输入密码。</p>
<form method="POST" action="/device/verify">
  <label>配对码</label>
  <input class="code" name="code" value="${escapeHtml(codeFromQuery)}" placeholder="XXXX-XXXX" required>
  <label>密码</label>
  <input type="password" name="password" placeholder="访问密码" required autocomplete="current-password">
  <button type="submit">授权设备</button>
</form>
${codeFromQuery ? "" : `<p class="err">未携带配对码，请手动输入终端上显示的码。</p>`}`,
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) return page("验证设备", `<h1>请求无效</h1><p>请使用页面上的表单。</p>`, 400);

  const userCode = String(form.get("code") ?? "").trim().toUpperCase();
  const password = String(form.get("password") ?? "");

  if (!constantTimeEquals(password, env.AUTH_PASSWORD)) {
    return page(
      "验证设备",
      `<h1>连接这台电脑</h1>
<p>密码不正确，请重试。</p>
<form method="POST" action="/device/verify">
  <label>配对码</label>
  <input class="code" name="code" value="${escapeHtml(userCode)}" required>
  <label>密码</label>
  <input type="password" name="password" placeholder="访问密码" required autocomplete="current-password">
  <button type="submit">授权设备</button>
</form>
<p class="err">密码错误。</p>`,
      401,
    );
  }

  // 确保设备行存在：配对码里记着设备名与（可能已吊销的）旧 id
  const row = (await getDeviceCodeByUserCode(env, userCode)) as any;
  if (!row || row.status !== "pending" || Date.parse(row.expires_at) < Date.now()) {
    return page(
      "验证设备",
      `<h1>配对码无效</h1><p>码不存在或已过期，请在设备终端上重新运行连接命令。</p>`,
      400,
    );
  }

  // 幂等：同一码重复提交（双击/刷新）不再建行
  if (row.approved_device_id && (await findDevice(env, row.approved_device_id))) {
    return page(
      "设备已授权",
      `<div class="ok">✓</div>
<h1>设备已授权</h1>
<p>配对码 <strong style="color:#e8e8e8">${escapeHtml(userCode)}</strong> 已通过。<br>
可以关闭此页面，回到终端继续。</p>`,
    );
  }

  let deviceId: string;
  if (row.device_id && (await findDevice(env, row.device_id))) {
    deviceId = row.device_id;
  } else {
    deviceId = await createDevice(env, { deviceId: row.device_id, deviceName: row.device_name });
  }

  const ok = await approveDeviceCode(env, userCode, deviceId);
  if (!ok) {
    return page("验证设备", `<h1>配对码无效</h1><p>码已使用或过期，请重新发起连接。</p>`, 400);
  }

  return page(
    "设备已授权",
    `<div class="ok">✓</div>
<h1>设备已授权</h1>
<p>配对码 <strong style="color:#e8e8e8">${escapeHtml(userCode)}</strong> 已通过。<br>
可以关闭此页面，回到终端继续。</p>`,
  );
}

async function getDeviceCodeByUserCode(env: Env, userCode: string): Promise<any | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mcp_device_codes?user_code=eq.${encodeURIComponent(userCode)}&select=*`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as any[];
  return rows[0] ?? null;
}

/** 简单的常量时间比较，避免逐字节短路。 */
export function constantTimeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) {
    // 仍然走完比较，保持耗时接近
    let diff = ba.length ^ bb.length;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ ba[i];
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
