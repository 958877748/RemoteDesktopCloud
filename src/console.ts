/**
 * Step 6 — 控制台页面：设备列表 / 在线状态 / 一键复制接入命令。
 *
 * 路由（在 `src/index.ts` 里挂）：
 *   GET  /                    → 登录页（无 session）或设备面板
 *   POST /login               → 校验 AUTH_PASSWORD → 建 session（KV）→ 303 /
 *   POST /logout              → 删 session → 清 cookie → 303 /
 *   GET  /api/devices         → JSON 设备列表
 *   POST /api/devices/revoke  → 删设备行（级联清掉它的调用行）
 *   GET  /api/info            → 原来挂在 `/` 上的自描述 JSON
 *
 * 鉴权：乙方案的同一个密码，通过后发一个随机 token 存进 `OAUTH_KV`
 * （前缀 `console:`，7 天过期），cookie 是 HttpOnly + SameSite=Lax。
 * SameSite=Lax 挡住跨站 POST；再加一层：两个写接口只收 JSON body，
 * 跨站 HTML 表单发不出 JSON。
 */
import { constantTimeEquals, escapeHtml, page } from "./device-auth.js";
import type { Env } from "./env.js";
import { deleteDevice, listDevices } from "./supabase.js";
import { SERVER_NAME, SERVER_VERSION } from "./mcp.js";

const COOKIE = "rdc_console";
const SESSION_TTL_S = 7 * 24 * 3600;

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function hasSession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  return (await env.OAUTH_KV.get(`console:${token}`)) !== null;
}

/** 页面上「Add a device」复制走的命令；`origin` 取当前访问的源，本地/线上各是各的。 */
function pairCommand(origin: string): string {
  return `MCP_SERVER_URL=${origin} npx @wonderwhy-er/desktop-commander@latest remote`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function deviceRows(devices: any[]): string {
  if (!devices.length) {
    return `<div class="empty">
  <div class="empty-ic">🖥</div>
  <p><strong>No devices yet</strong></p>
  <p class="dim">Run the pairing command below on a machine you want your AI clients to reach.</p>
</div>`;
  }
  return devices
    .map((d) => {
      const on = d.status === "online";
      const ver = d.capabilities?.app_version ? ` · v${d.capabilities.app_version}` : "";
      return `<div class="row">
  <span class="dot${on ? " on" : ""}"></span>
  <div class="who">
    <div class="name">${escapeHtml(d.device_name)}</div>
    <div class="meta">Last seen ${escapeHtml(fmtTime(d.last_seen))}${escapeHtml(ver)}</div>
  </div>
  <div class="spacer"></div>
  <span class="badge${on ? " on" : ""}">${on ? "Online" : "Offline"}</span>
  <button class="danger" data-revoke="${escapeHtml(d.id)}" data-name="${escapeHtml(d.device_name)}">Revoke</button>
</div>`;
    })
    .join("\n");
}

function dashboard(origin: string, devices: any[]): Response {
  const online = devices.filter((d) => d.status === "online").length;
  const cmd = pairCommand(origin);
  const mcpUrl = `${origin}/mcp`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Devices · Remote MCP</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0d0d0d;color:#e9e9e9;
     font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:44px 24px 90px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
h1{font-size:34px;font-weight:700;margin:0;letter-spacing:-.5px}
.sub{color:#9a9a9a;margin-top:8px;font-size:15px}
.btn{background:#3b82f6;color:#fff;border:0;border-radius:9px;padding:12px 18px;font-size:15px;
     font-weight:500;cursor:pointer;white-space:nowrap}
.btn:hover{background:#2f6fe0}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:14px;margin-top:28px;overflow:hidden}
.chead{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;
       border-bottom:1px solid #242424}
.chead h2{font-size:17px;margin:0;font-weight:600}
.count{color:#8a8a8a;font-size:13px}
.row{display:flex;align-items:center;gap:16px;padding:18px 24px;border-bottom:1px solid #1f1f1f}
.row:last-child{border-bottom:0}
.dot{width:10px;height:10px;border-radius:50%;background:#4b5563;flex:none}
.dot.on{background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.14)}
.who{min-width:0}
.name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;word-break:break-all}
.meta{color:#8a8a8a;font-size:13px;margin-top:5px}
.spacer{flex:1}
.badge{font-size:13px;padding:5px 13px;border-radius:999px;white-space:nowrap}
.badge.on{background:rgba(16,163,127,.16);color:#34d399}
.badge:not(.on){color:#8a8a8a}
.danger{background:transparent;border:1px solid #ef4444;color:#ef4444;border-radius:8px;
        padding:7px 14px;font-size:13px;cursor:pointer}
.danger:hover{background:rgba(239,68,68,.12)}
.empty{padding:46px 24px;text-align:center}
.empty-ic{font-size:34px;margin-bottom:12px}
.empty p{margin:6px 0;font-size:15px}
.dim{color:#8a8a8a;font-size:14px!important;line-height:1.6}
.body{padding:22px 24px}
.hint{color:#9a9a9a;font-size:14px;line-height:1.6;margin:0 0 16px}
.code{position:relative;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px;padding:16px 18px;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;color:#e5e5e5;
      overflow-x:auto;white-space:pre-wrap;word-break:break-all;line-height:1.7}
.mini{background:#242424;border:1px solid #333;color:#d0d0d0;border-radius:7px;padding:6px 12px;
      font-size:12.5px;cursor:pointer;position:absolute;top:10px;right:10px}
.mini:hover{background:#2e2e2e}
.kv{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
details{margin-top:16px;color:#8a8a8a;font-size:13.5px}
summary{cursor:pointer}
details .code{margin-top:10px}
.foot{color:#5f5f5f;font-size:13px;margin-top:34px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.foot a{color:#5f5f5f}
.foot button{background:none;border:0;color:#5f5f5f;font-size:13px;cursor:pointer;padding:0;text-decoration:underline}
.toast{position:fixed;left:50%;bottom:34px;transform:translate(-50%,20px);background:#10a37f;color:#fff;
       padding:11px 20px;border-radius:9px;font-size:14.5px;opacity:0;pointer-events:none;
       transition:.22s;z-index:50}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:#ef4444}
</style></head><body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>Devices</h1>
      <div class="sub">Machines your AI clients can reach through Remote MCP.</div>
    </div>
    <button class="btn" id="add">+ Add a device</button>
  </div>

  <div class="card">
    <div class="chead">
      <h2>Your devices</h2>
      <span class="count" id="count">${online}/${devices.length} online</span>
    </div>
    <div id="list">
${deviceRows(devices)}
    </div>
  </div>

  <div class="card">
    <div class="chead"><h2>Add a device</h2></div>
    <div class="body">
      <p class="hint">Run this in a terminal on the machine you want to control. A browser opens to
        confirm the pairing code and the <strong style="color:#e9e9e9">access password</strong>;
        keep that terminal running to stay online.</p>
      <div class="code"><button class="mini" data-copy="cmd">Copy</button><span id="cmd">${escapeHtml(cmd)}</span></div>
      <details>
        <summary>Connection can't reach workers.dev?</summary>
        <div class="code"><button class="mini" data-copy="proxy">Copy</button><span id="proxy">NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 ${escapeHtml(cmd)}</span></div>
      </details>
    </div>
  </div>

  <div class="card">
    <div class="chead"><h2>Where you use it</h2></div>
    <div class="body">
      <p class="hint">Add this as a custom connector in ChatGPT (Settings → Connectors).</p>
      <div class="code"><button class="mini" data-copy="mcp">Copy</button><span id="mcp">${escapeHtml(mcpUrl)}</span></div>
    </div>
  </div>

  <div class="foot">
    <span>${escapeHtml(SERVER_NAME)} v${escapeHtml(SERVER_VERSION)}</span>
    <span>·</span>
    <span>Session expires in 7 days</span>
    <form method="POST" action="/logout" style="margin:0"><button type="submit">Sign out</button></form>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, bad) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.className = 'toast', 2200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}
async function doCopy(id, label) {
  const el = document.getElementById(id);
  const ok = await copyText(el ? el.textContent : '');
  toast(ok ? label + ' copied — paste it in a terminal' : 'Copy failed, select it manually', !ok);
}

document.getElementById('add').addEventListener('click', () => doCopy('cmd', 'Pairing command'));
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
  const id = b.getAttribute('data-copy');
  doCopy(id, id === 'mcp' ? 'Connector URL' : 'Command');
}));

document.getElementById('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revoke]');
  if (!btn) return;
  const id = btn.getAttribute('data-revoke');
  const name = btn.getAttribute('data-name');
  if (!confirm('Revoke \"' + name + '\"?\\n\\nIt drops out of every AI client until you pair it again with the command below.')) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch('/api/devices/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error(await r.text());
    toast(name + ' revoked');
    await refresh();
  } catch (err) {
    toast('Revoke failed: ' + (err && err.message ? err.message : err), true);
    btn.disabled = false; btn.textContent = 'Revoke';
  }
});

async function refresh() {
  try {
    const r = await fetch('/api/devices', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) { if (r.status === 401) location.reload(); return; }
    const data = await r.json();
    document.getElementById('list').innerHTML = data.html;
    document.getElementById('count').textContent = data.online + '/' + data.total + ' online';
  } catch (_) { /* 网络抖动：下一轮再试 */ }
}
setInterval(refresh, 5000);
</script>
</body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

export async function handleConsole(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (!(await hasSession(env, readCookie(request, COOKIE)))) {
    return page(
      "Remote MCP 控制台",
      `<h1>Remote MCP 控制台</h1>
<p>查看已配对的设备、在线状态，并拿到接入命令。</p>
<form method="POST" action="/login">
  <label>访问密码</label>
  <input type="password" name="password" placeholder="访问密码" required autocomplete="current-password">
  <button type="submit">进入控制台</button>
</form>`,
    );
  }
  const devices = await listDevices(env);
  return dashboard(origin, devices);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const origin = new URL(request.url).origin;

  if (!constantTimeEquals(password, env.AUTH_PASSWORD)) {
    return page(
      "Remote MCP 控制台",
      `<h1>Remote MCP 控制台</h1>
<p>查看已配对的设备、在线状态，并拿到接入命令。</p>
<form method="POST" action="/login">
  <label>访问密码</label>
  <input type="password" name="password" placeholder="访问密码" required autocomplete="current-password">
  <button type="submit">进入控制台</button>
</form>
<p class="err">密码错误。</p>`,
      401,
    );
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.OAUTH_KV.put(`console:${token}`, String(Date.now()), { expirationTtl: SESSION_TTL_S });

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${secure}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, COOKIE);
  if (token) await env.OAUTH_KV.delete(`console:${token}`).catch(() => void 0);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// /api/devices 与 /api/devices/revoke
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleDevicesApi(request: Request, env: Env): Promise<Response> {
  if (!(await hasSession(env, readCookie(request, COOKIE)))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    const devices = await listDevices(env);
    return json({
      total: devices.length,
      online: devices.filter((d) => d.status === "online").length,
      devices,
      // 列表片段由服务端生成，前端只做 innerHTML，避免两边各写一套模板
      html: deviceRows(devices),
    });
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "invalid device id" }, 400);
    await deleteDevice(env, id);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

/** 原来挂在 `/` 上的自描述 JSON，控制台接管首页后挪到这里。 */
export function handleInfo(): Response {
  return Response.json(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp: "/mcp",
      authorize: "/authorize",
      console: "/",
      device: ["/api/mcp-info", "/device/start", "/device/verify", "/device/poll"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
