#!/usr/bin/env node
/**
 * Step 3 自测：把 ChatGPT 的完整 OAuth 流程用 curl 顺序走一遍。
 *
 *   1  POST /mcp（无 token）        → 401 + WWW-Authenticate.resource_metadata
 *   2  GET  资源元数据（两条路径）    → 200，resource = origin
 *   3  GET  授权服务器元数据          → 200，含 /authorize /token /register + PKCE S256
 *   4  POST /register（RFC 7591）    → client_id
 *   5  GET  /authorize               → 200 密码页
 *   6  POST /authorize（带密码）     → 302 + code
 *   7  POST /token                   → access_token
 *   8  POST /mcp initialize          → 200
 *   9  POST /mcp tools/list          → 恰好 29 个工具
 *   10 POST /mcp tools/call          → who_am_i / list_devices 直答，其余走 Step 4 转发
 *
 * 用法：node scripts/test-oauth-flow.mjs [baseUrl]
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
/**
 * 控制台 / GoTrue 登录密码。
 * 禁止硬编码默认值 —— 本仓库是 public，任何写进来的字面量都会被全世界读到。
 * 只从环境变量，或 .dev.vars / .env（这俩不入库）里取；取不到就直接失败。
 */
const PASSWORD = (() => {
  if (process.env.AUTH_PASSWORD) return process.env.AUTH_PASSWORD;
  for (const p of ["../.dev.vars", "../.env"]) {
    try {
      const m = readFileSync(new URL(p, import.meta.url), "utf8").match(/^AUTH_PASSWORD=(.*)$/m);
      if (m?.[1].trim()) return m[1].trim();
    } catch { /* 文件不存在，试下一个 */ }
  }
  throw new Error("AUTH_PASSWORD 未设置：写入 .dev.vars / .env（不入库），或用环境变量传入");
})();
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

const b64url = (buf) => buf.toString("base64url");
const s256 = (v) => b64url(createHash("sha256").update(v).digest());

// --- 1. /mcp 无 token -------------------------------------------------------
section(1, "POST /mcp（无 token）");
const noAuth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const challenge = noAuth.headers.get("www-authenticate") ?? "";
check(`status 401 (实际 ${noAuth.status})`, noAuth.status === 401);
check(`WWW-Authenticate 有 resource_metadata`, /resource_metadata="/.test(challenge), challenge);
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
check(`resource_metadata 解析得到`, Boolean(metadataUrl), metadataUrl ?? "");

// --- 2. 资源元数据 -----------------------------------------------------------
section(2, "RFC 9728 资源元数据");
const origin = new URL(BASE).origin;
const prms = await Promise.all(
  [`${origin}/.well-known/oauth-protected-resource`, `${origin}/.well-known/oauth-protected-resource/mcp`].map(async (u) => {
    const r = await fetch(u);
    return { u, r, body: await r.json().catch(() => null) };
  }),
);
for (const { u, r, body } of prms) {
  check(`${new URL(u).pathname} → 200 (实际 ${r.status})`, r.status === 200);
  check(`${new URL(u).pathname} resource = origin`, body?.resource === origin, JSON.stringify(body?.resource));
}
if (metadataUrl) {
  const r = await fetch(metadataUrl);
  check(`401 里的 resource_metadata 可访问 (实际 ${r.status})`, r.status === 200);
}
const prm = prms[0].body;
check(`authorization_servers 含 origin`, Array.isArray(prm?.authorization_servers) && prm.authorization_servers.includes(origin));
check(`scopes_supported 含 mcp:tools`, Array.isArray(prm?.scopes_supported) && prm.scopes_supported.includes("mcp:tools"), JSON.stringify(prm?.scopes_supported));

// --- 3. 授权服务器元数据 -----------------------------------------------------
section(3, "RFC 8414 授权服务器元数据");
const asr = await fetch(`${origin}/.well-known/oauth-authorization-server`);
const as = await r_json(asr);
check(`status 200 (实际 ${asr.status})`, asr.status === 200);
check(`issuer = origin`, as?.issuer === origin, JSON.stringify(as?.issuer));
check(`authorization_endpoint = /authorize`, as?.authorization_endpoint === `${origin}/authorize`, as?.authorization_endpoint);
check(`token_endpoint = /token`, as?.token_endpoint === `${origin}/token`, as?.token_endpoint);
check(`registration_endpoint = /register`, as?.registration_endpoint === `${origin}/register`, as?.registration_endpoint);
check(`code_challenge_methods 含 S256`, Array.isArray(as?.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes("S256"), JSON.stringify(as?.code_challenge_methods_supported));
check(`scopes_supported 含 mcp:tools`, Array.isArray(as?.scopes_supported) && as.scopes_supported.includes("mcp:tools"), JSON.stringify(as?.scopes_supported));

// --- 4. DCR ------------------------------------------------------------------
section(4, "RFC 7591 动态注册");
const regRes = await fetch(`${origin}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: "ChatGPT (test)",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const reg = await r_json(regRes);
check(`status 201 Created (实际 ${regRes.status})`, regRes.status === 201, JSON.stringify(reg));
const clientId = reg?.client_id;
check(`拿到 client_id`, Boolean(clientId), clientId ?? "");

// --- 5. GET /authorize --------------------------------------------------------
section(5, "GET /authorize（密码页）");
const verifier = b64url(randomBytes(32));
const challengeValue = s256(verifier);
const state = b64url(randomBytes(16));
const authQuery = new URLSearchParams({
  response_type: "code",
  client_id: clientId ?? "",
  redirect_uri: REDIRECT_URI,
  scope: "mcp:tools desktop:auth",
  state,
  code_challenge: challengeValue,
  code_challenge_method: "S256",
  resource: origin,
});
const authGet = await fetch(`${origin}/authorize?${authQuery}`);
const authHtml = await authGet.text();
check(`status 200 (实际 ${authGet.status})`, authGet.status === 200, authHtml.slice(0, 200));
check(`页面含密码表单`, /name="password"/.test(authHtml));
check(`action 保留 query`, /action="\/authorize\?/.test(authHtml));

// --- 6. POST /authorize -------------------------------------------------------
section(6, "POST /authorize（提交密码 → 302 + code）");
const authPost = await fetch(`${origin}/authorize?${authQuery}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD }).toString(),
  redirect: "manual",
});
const location = authPost.headers.get("location") ?? "";
check(`status 302 (实际 ${authPost.status})`, authPost.status === 302, (await authPost.text()).slice(0, 300));
const code = new URL(location || `${origin}/?x=1`).searchParams.get("code");
check(`拿到 authorization code`, Boolean(code), location.slice(0, 160));
check(`redirect 回 redirect_uri`, location.startsWith(REDIRECT_URI), location.slice(0, 160));

// --- 7. POST /token -----------------------------------------------------------
section(7, "POST /token（code 换 access_token）");
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
const token = await r_json(tokenRes);
check(`status 200 (实际 ${tokenRes.status})`, tokenRes.status === 200, JSON.stringify(token).slice(0, 300));
check(`拿到 access_token`, Boolean(token?.access_token));
const accessToken = token?.access_token ?? "";

// --- 8. initialize ------------------------------------------------------------
section(8, "POST /mcp initialize");
const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${accessToken}`,
};
const initRes = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rdc-oauth-test", version: "0.0.1" } },
  }),
});
const initText = await initRes.text();
check(`status 200 (实际 ${initRes.status})`, initRes.status === 200, initText.slice(0, 300));
const initBody = parseBody(initText);
check(`serverInfo.name = remotedesktopcloud`, initBody?.result?.serverInfo?.name === "remotedesktopcloud", JSON.stringify(initBody?.result?.serverInfo));

// --- 9. tools/list ------------------------------------------------------------
section(9, "POST /mcp tools/list（须 29 个）");
const listRes = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
const listText = await listRes.text();
check(`status 200 (实际 ${listRes.status})`, listRes.status === 200, listText.slice(0, 300));
const tools = parseBody(listText)?.result?.tools ?? [];
check(`工具数 = 29（实际 ${tools.length}）`, tools.length === 29, tools.map((t) => t.name).join(","));
const names = new Set(tools.map((t) => t.name));
for (const required of ["list_devices", "ping", "who_am_i", "shutdown"]) {
  check(`含 remote 工具 ${required}`, names.has(required));
}
check(`不含 get_prompts`, !names.has("get_prompts"));
check(`全部带 object inputSchema`, tools.every((t) => t.inputSchema?.type === "object"));
check(`全部带 description`, tools.every((t) => typeof t.description === "string" && t.description.length > 0));

// --- 10. tools/call -----------------------------------------------------------
section(10, "POST /mcp tools/call");
async function call(name, args = {}) {
  const r = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  return { status: r.status, body: parseBody(t), raw: t };
}

const who = await call("who_am_i");
const whoText = who.body?.result?.content?.[0]?.text ?? "";
check(`who_am_i 200 (实际 ${who.status})`, who.status === 200, who.raw.slice(0, 300));
check(`who_am_i 返回 USER_ID`, whoText.includes("56d074bb-5421-45c1-aac3-600f2cb790e7"), whoText.slice(0, 200));
check(`who_am_i 非 isError`, who.body?.result?.isError !== true, who.raw.slice(0, 300));

const devices = await call("list_devices");
const deviceText = devices.body?.result?.content?.[0]?.text ?? "";
check(`list_devices 200 (实际 ${devices.status})`, devices.status === 200, devices.raw.slice(0, 300));
check(`list_devices 返回 JSON.devices`, /"devices"/.test(deviceText), deviceText.slice(0, 200));
check(`list_devices 非 isError`, devices.body?.result?.isError !== true, devices.raw.slice(0, 300));

const readFile = await call("read_file", { path: "/etc/hostname" });
check(`read_file 200 (实际 ${readFile.status})`, readFile.status === 200, readFile.raw.slice(0, 300));
const readFileText = readFile.body?.result?.content?.[0]?.text ?? "";
check(`read_file 不再是 Step 4 占位`, !/Step 4/.test(readFileText), readFileText.slice(0, 300));
check(
  `read_file 要么在设备上执行、要么给出可读原因`,
  readFile.body?.result?.isError === true || readFileText.length > 0,
  readFileText.slice(0, 300),
);

// --- 附：resource 垫片 --------------------------------------------------------
section(11, "resource = origin/mcp 垫片（全新一轮 code）");
const shimQuery = new URLSearchParams(authQuery);
shimQuery.set("resource", `${origin}/mcp`);
const shimVerifier = b64url(randomBytes(32));
shimQuery.set("code_challenge", s256(shimVerifier));

const shimGet = await fetch(`${origin}/authorize?${shimQuery}`);
check(`GET /authorize 接受 resource=origin/mcp (实际 ${shimGet.status})`, shimGet.status === 200, (await shimGet.text()).slice(0, 300));

const shimPost = await fetch(`${origin}/authorize?${shimQuery}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD }).toString(),
  redirect: "manual",
});
check(`POST /authorize 接受 resource=origin/mcp (实际 ${shimPost.status})`, shimPost.status === 302, (await shimPost.text()).slice(0, 300));
const shimCode = new URL(shimPost.headers.get("location") ?? `${origin}/?x=1`).searchParams.get("code");
check(`resource=origin/mcp 也能拿到 code`, Boolean(shimCode));

const shimToken = await fetch(`${origin}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: shimCode ?? "",
    redirect_uri: REDIRECT_URI,
    client_id: clientId ?? "",
    code_verifier: shimVerifier,
    resource: `${origin}/mcp`,
  }).toString(),
});
const shimTokenBody = await r_json(shimToken);
check(
  `POST /token 的 resource=origin/mcp 换到 token (实际 ${shimToken.status})`,
  shimToken.status === 200 && Boolean(shimTokenBody?.access_token),
  JSON.stringify(shimTokenBody).slice(0, 300),
);

// --- 附：未注册 client_id 的 DCR 兜底 -----------------------------------------
section(12, "未注册 client_id 的 DCR 兜底");
const uuid = crypto.randomUUID();
const fallbackQuery = new URLSearchParams({
  response_type: "code",
  client_id: uuid,
  redirect_uri: REDIRECT_URI,
  scope: "mcp:tools",
  state,
  code_challenge: s256(b64url(randomBytes(32))),
  code_challenge_method: "S256",
});
const fallbackGet = await fetch(`${origin}/authorize?${fallbackQuery}`);
const fallbackHtml = await fallbackGet.text();
check(`未注册 UUID client_id → 200 (实际 ${fallbackGet.status})`, fallbackGet.status === 200, fallbackHtml.slice(0, 300));
check(`兜底后能解析出 client`, /name="password"/.test(fallbackHtml));

const badRedirect = new URLSearchParams(fallbackQuery);
badRedirect.set("redirect_uri", "http://evil.example.com/cb");
const badGet = await fetch(`${origin}/authorize?${badRedirect}`);
check(`非 https 的 redirect_uri 不兜底 (实际 ${badGet.status})`, badGet.status === 400, (await badGet.text()).slice(0, 300));

// --- 汇总 ---------------------------------------------------------------------
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

// ---------------------------------------------------------------------------

async function r_json(res) {
  return res.json().catch(() => null);
}

function parseBody(text) {
  if (!text) return null;
  if (text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const joined = lines.map((l) => l.slice(5).trim()).join("");
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
