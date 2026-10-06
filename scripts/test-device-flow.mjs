#!/usr/bin/env node
/**
 * Step 2 端到端自测：模拟设备端完整配对流程（不依赖真实 npx 客户端）。
 *
 *   node scripts/test-device-flow.mjs [baseURL]
 *
 * 覆盖：/api/mcp-info → /device/start → /device/verify(POST) → /device/poll
 * 断言：PKCE 校验、GoTrue token 可用、mcp_devices 行存在。
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const PASSWORD = process.env.AUTH_PASSWORD ?? "Relay-DCM-2026";

let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const b64url = (buf) => buf.toString("base64url");

/** 直连 DB 统计设备行数（验证一次配对只建一行）。连不上则跳过。 */
async function deviceRowCount() {
  try {
    const url = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^DATABASE_URL=(.*)$/m)?.[1];
    if (!url) return null;
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const r = await client.query("select count(*)::int as n from mcp_devices where device_name = 'selftest-host'");
    await client.end();
    return r.rows[0].n;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n== 设备配对流程 @ ${BASE} ==\n`);
  const rowsBefore = await deviceRowCount();

  // 1. mcp-info
  const info = await (await fetch(`${BASE}/api/mcp-info`)).json();
  ok(!!info.supabaseUrl, "/api/mcp-info 返回 supabaseUrl", info.supabaseUrl);
  ok(/^sb_publishable_/.test(info.supabasePublishableKey ?? ""), "/api/mcp-info 返回 publishable key");

  // 2. device/start（按设备端真实 PKCE 逻辑生成）
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const startRes = await fetch(`${BASE}/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "mcp-device",
      scope: "mcp:tools",
      device_name: "selftest-host",
      device_type: "mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  const flow = await startRes.json();
  ok(startRes.ok, "/device/start 200");
  ok(!!flow.device_code && !!flow.user_code && !!flow.verification_uri_complete,
    "返回 device_code / user_code / verification_uri_complete", flow.user_code);
  ok(flow.interval === 5 && flow.expires_in > 0, "返回 interval / expires_in", `${flow.interval}s / ${flow.expires_in}s`);

  // 3. poll（未批准 → authorization_pending）
  const pendingRes = await fetch(`${BASE}/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: flow.device_code, client_id: "mcp-device", code_verifier: verifier }),
  });
  const pending = await pendingRes.json();
  ok(pendingRes.status === 400 && pending.error === "authorization_pending",
    "未批准时 poll → authorization_pending", pending.error);

  // 4. browser verify（密码 + 配对码）
  const verifyRes = await fetch(`${BASE}/device/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: flow.user_code, password: PASSWORD }).toString(),
    redirect: "manual",
  });
  const verifyHtml = await verifyRes.text();
  ok(verifyRes.ok && verifyHtml.includes("已授权"), "verify 页面授权成功", `status=${verifyRes.status}`);
  if (!verifyRes.ok) console.log("    页面片段:", verifyHtml.slice(0, 300));

  // 5. poll（批准 → GoTrue token）
  const doneRes = await fetch(`${BASE}/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: flow.device_code, client_id: "mcp-device", code_verifier: verifier }),
  });
  const done = await doneRes.json();
  ok(doneRes.ok, "批准后 poll 200", `status=${doneRes.status}`);
  ok(!!done.access_token && !!done.refresh_token && !!done.device_id,
    "返回 access_token / refresh_token / device_id");
  if (!done.access_token) console.log("    响应:", JSON.stringify(done));

  // 6. device_id 归属：一次配对只能产生一行新设备（回归：曾出现 verify/poll 各建一行）
  if (rowsBefore !== null && done.device_id) {
    const rowsAfter = await deviceRowCount();
    ok(rowsAfter === rowsBefore + 1, "一次配对只新增 1 个设备行", `${rowsBefore} → ${rowsAfter}`);
  }

  // 7. token 真实性：用它调 /auth/v1/user
  if (done.access_token) {
    const userRes = await fetch(`${info.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: info.supabasePublishableKey, Authorization: `Bearer ${done.access_token}` },
    });
    const user = await userRes.json();
    ok(userRes.ok && !!user.id, "GoTrue token 可换取 /auth/v1/user", user.id);
    ok(user.role === "authenticated", "token role = authenticated", user.role);
  }

  // 8. device_code 一次性（重放应失效）
  const replayRes = await fetch(`${BASE}/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: flow.device_code, client_id: "mcp-device", code_verifier: verifier }),
  });
  const replay = await replayRes.json();
  ok(replay.error === "expired_token", "device_code 用后即焚", replay.error);

  // 9. 错密码
  const badRes = await fetch(`${BASE}/device/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: flow.user_code, password: "wrong" }).toString(),
  });
  ok(badRes.status === 401, "错误密码 → 401", `status=${badRes.status}`);

  console.log(failures === 0 ? "\n✅ 全部通过\n" : `\n❌ ${failures} 项失败\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("💥", e.message);
  process.exit(1);
});
