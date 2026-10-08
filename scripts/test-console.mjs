#!/usr/bin/env node
/**
 * Step 6 自测：控制台页面 + 它的两个 API。
 *
 *   node scripts/test-console.mjs [baseUrl]
 *
 * 覆盖：登录页 → 密码错/对 → session cookie → 面板渲染 →
 *       /api/devices（无 cookie 401）→ revoke（建一条临时设备行再删掉，
 *       不碰真实设备）→ logout → /api/info
 */
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
const ORIGIN = new URL(BASE).origin;

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
const section = (n, t) => console.log(`\n[${n}] ${t}`);
const text = (r) => r.text();

/** 从 .dev.vars 取 Supabase 凭据，用来造/查临时设备行。 */
function supa() {
  const v = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(v)?.[1]?.trim();
  return { url: get("SUPABASE_URL"), key: get("SUPABASE_SERVICE_ROLE_KEY"), userId: get("USER_ID") };
}
const S = supa();
const restHeaders = { apikey: S.key, Authorization: `Bearer ${S.key}`, "Content-Type": "application/json" };

// --- 1. 未登录 --------------------------------------------------------------
section(1, "未登录");
const anon = await fetch(`${BASE}/`);
const anonHtml = await text(anon);
check(`GET / → 200 登录页 (实际 ${anon.status})`, anon.status === 200, anonHtml.slice(0, 200));
check(`含密码表单`, /action="\/login"/.test(anonHtml), anonHtml.slice(0, 200));
check(`不含设备列表`, !/Your devices/.test(anonHtml));

const anonApi = await fetch(`${BASE}/api/devices`);
check(`GET /api/devices 无 cookie → 401 (实际 ${anonApi.status})`, anonApi.status === 401);

// --- 2. 登录 ----------------------------------------------------------------
section(2, "登录");
const badPost = await fetch(`${BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: "wrong-password" }).toString(),
  redirect: "manual",
});
check(`错密码 → 401 (实际 ${badPost.status})`, badPost.status === 401, (await text(badPost)).slice(0, 200));

const goodPost = await fetch(`${BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD }).toString(),
  redirect: "manual",
});
const setCookie = goodPost.headers.get("set-cookie") ?? "";
const token = /rdc_console=([^;]+)/.exec(setCookie)?.[1] ?? "";
check(`对密码 → 303 (实际 ${goodPost.status})`, goodPost.status === 303, String(goodPost.status));
check(`Location = /`, goodPost.headers.get("location") === "/", goodPost.headers.get("location") ?? "");
check(`下发 HttpOnly cookie`, /HttpOnly/i.test(setCookie) && Boolean(token), setCookie.slice(0, 160));
check(`SameSite=Lax`, /SameSite=Lax/i.test(setCookie), setCookie.slice(0, 160));
const cookie = `rdc_console=${token}`;

// --- 3. 面板 ----------------------------------------------------------------
section(3, "设备面板");
const dash = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
const dashHtml = await text(dash);
check(`GET / 带 cookie → 200 (实际 ${dash.status})`, dash.status === 200, dashHtml.slice(0, 200));
check(`标题 Devices`, />Devices</.test(dashHtml), dashHtml.slice(0, 200));
check(`有 Your devices 卡片`, /Your devices/.test(dashHtml));
check(`有 + Add a device 按钮`, /\+ Add a device/.test(dashHtml));
check(
  `接入命令含当前 origin`,
  dashHtml.includes(`MCP_SERVER_URL=${ORIGIN} npx @wonderwhy-er/desktop-commander@latest remote`),
  ORIGIN,
);
check(`含 ChatGPT 连接器 URL`, dashHtml.includes(`${ORIGIN}/mcp`));
check(`含 5s 轮询`, /setInterval\(refresh, 5000\)/.test(dashHtml));
check(`含 Sign out`, /action="\/logout"/.test(dashHtml));

// --- 4. /api/devices --------------------------------------------------------
section(4, "GET /api/devices");
const listRes = await fetch(`${BASE}/api/devices`, { headers: { Cookie: cookie } });
const list = await listRes.json().catch(() => null);
check(`带 cookie → 200 (实际 ${listRes.status})`, listRes.status === 200, String(listRes.status));
check(`返回 total/online/devices/html`, !!list && "total" in list && "online" in list && "html" in list, JSON.stringify(list).slice(0, 200));
check(`online ≤ total`, (list?.online ?? 0) <= (list?.total ?? 0), `${list?.online}/${list?.total}`);
check(`真实设备 Mac 在列表里`, (list?.devices ?? []).some((d) => d.device_name === "Mac"), JSON.stringify(list?.devices).slice(0, 200));

// --- 5. revoke --------------------------------------------------------------
section(5, "POST /api/devices/revoke");
const badId = await fetch(`${BASE}/api/devices/revoke`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ id: "not-a-uuid" }),
});
check(`非法 id → 400 (实际 ${badId.status})`, badId.status === 400, String(badId.status));

const noJson = await fetch(`${BASE}/api/devices/revoke`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
  body: "id=abc",
});
check(`非 JSON body → 400 (挡跨站表单) (实际 ${noJson.status})`, noJson.status === 400, String(noJson.status));

const tempId = crypto.randomUUID();
const created = await fetch(`${S.url}/rest/v1/mcp_devices`, {
  method: "POST",
  headers: restHeaders,
  body: JSON.stringify({
    id: tempId,
    user_id: S.userId,
    device_name: "console-selftest",
    status: "offline",
    capabilities: {},
    last_seen: new Date().toISOString(),
  }),
});
check(`临时设备行建好 (实际 ${created.status})`, created.status === 201, await text(created));

const revoke = await fetch(`${BASE}/api/devices/revoke`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ id: tempId }),
});
check(`revoke → 200 (实际 ${revoke.status})`, revoke.status === 200, await text(revoke));

const after = await fetch(`${S.url}/rest/v1/mcp_devices?id=eq.${tempId}`, { headers: restHeaders });
check(`临时行已被删除`, (await after.json()).length === 0);

const again = await fetch(`${BASE}/api/devices/revoke`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ id: tempId }),
});
check(`重复 revoke 幂等 → 200 (实际 ${again.status})`, again.status === 200, String(again.status));

const stillThere = await fetch(`${S.url}/rest/v1/mcp_devices?device_name=eq.Mac&select=id`, { headers: restHeaders });
check(`真实设备 Mac 未被误删`, (await stillThere.json()).length === 1);

// --- 6. logout --------------------------------------------------------------
section(6, "登出");
const logout = await fetch(`${BASE}/logout`, {
  method: "POST",
  headers: { Cookie: cookie },
  redirect: "manual",
});
check(`logout → 303 (实际 ${logout.status})`, logout.status === 303, String(logout.status));
check(`清 cookie Max-Age=0`, /Max-Age=0/i.test(logout.headers.get("set-cookie") ?? ""), logout.headers.get("set-cookie") ?? "");

const stale = await fetch(`${BASE}/api/devices`, { headers: { Cookie: cookie } });
check(`已登出的 session → 401 (实际 ${stale.status})`, stale.status === 401, String(stale.status));

// --- 7. /api/info -----------------------------------------------------------
section(7, "GET /api/info");
const infoRes = await fetch(`${BASE}/api/info`);
const info = await infoRes.json().catch(() => null);
check(`→ 200 (实际 ${infoRes.status})`, infoRes.status === 200);
check(`mcp = /mcp`, info?.mcp === "/mcp", JSON.stringify(info));
check(`console = /`, info?.console === "/", JSON.stringify(info));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
