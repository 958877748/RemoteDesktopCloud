#!/usr/bin/env node
/**
 * 广播送达探针（Step 4 的坑 1 就是它测出来的）：
 *   node scripts/probe-broadcast.mjs real-jwt   # 带用户 JWT → 设备收到并执行 ✅
 *   node scripts/probe-broadcast.mjs real-apikey # 只带 apikey → 回 202 但被静默丢弃 ❌
 *   node scripts/probe-broadcast.mjs both|jwt|apikey # 只看 HTTP 状态码（不验证送达）
 *
 * `real-*` 模式会插一条真的 pending 行、发门铃、轮询它是否变成 completed，
 * 结束后删行。设备 id / user id / 密钥都写死在下面（单用户项目）。
 */
import { readFileSync } from "node:fs";

const mode = process.argv[2] ?? "both";
const SUPABASE_URL = "https://zdtxqyonglqnyrwayins.supabase.co";
const USER_ID = "56d074bb-5421-45c1-aac3-600f2cb790e7";
const DEVICE_ID = "3a43d74b-cb2b-441a-8a80-860cfbb64d20";

const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(vars)?.[1]?.trim();
const PUBLISHABLE = get("SUPABASE_PUBLISHABLE_KEY");
const EMAIL = get("USER_EMAIL");
const PASSWORD = get("AUTH_PASSWORD");

const headers = { apikey: PUBLISHABLE, "Content-Type": "application/json" };
if (mode !== "apikey" && mode !== "real-apikey") {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`password grant 失败: ${JSON.stringify(j).slice(0, 300)}`);
  headers.Authorization = `Bearer ${j.access_token}`;
}
if (mode === "apikey") delete headers.Authorization;

const callId = crypto.randomUUID();
const body = JSON.stringify({
  messages: [
    {
      topic: `user:${USER_ID}`,
      event: "new_call",
      payload: { call_id: callId, device_id: DEVICE_ID },
      private: true,
    },
  ],
});
const isReal = mode.startsWith("real-");
if (!isReal) {
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, { method: "POST", headers, body });
  console.log(`mode=${mode} → ${res.status} ${await res.text()}`);
  console.log(`call_id=${callId}`);
}

// 真实验：插一条真的 pending 行，用指定的 header 组合发门铃，
// 看设备会不会认领执行（这才能证明「送达」，202 只证明「收下了」）。
if (mode === "real-apikey" || mode === "real-jwt") {
  const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
  const realId = crypto.randomUUID();
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/mcp_remote_calls`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      id: realId,
      user_id: USER_ID,
      device_id: DEVICE_ID,
      tool_name: "ping",
      tool_args: {},
      metadata: {},
      status: "pending",
      timeout_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  if (!ins.ok) throw new Error(`insert 失败: ${await ins.text()}`);
  console.log(`真行 call_id=${realId}`);

  const h = { apikey: PUBLISHABLE, "Content-Type": "application/json" };
  if (mode === "real-jwt") h.Authorization = headers.Authorization;
  const b = JSON.stringify({
    messages: [{ topic: `user:${USER_ID}`, event: "new_call", payload: { call_id: realId, device_id: DEVICE_ID }, private: true }],
  });
  const r2 = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, { method: "POST", headers: h, body: b });
  console.log(`门铃(${mode}) → ${r2.status}`);

  let final = "pending";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const q = await fetch(`${SUPABASE_URL}/rest/v1/mcp_remote_calls?id=eq.${realId}&select=status`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    final = (await q.json())?.[0]?.status ?? "gone";
    if (final === "completed" || final === "failed") break;
  }
  console.log(`结果状态: ${final} → ${final === "completed" ? "✅ 设备收到了门铃" : "❌ 设备没收到门铃"}`);
  await fetch(`${SUPABASE_URL}/rest/v1/mcp_remote_calls?id=eq.${realId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
}
