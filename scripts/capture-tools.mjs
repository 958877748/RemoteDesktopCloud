#!/usr/bin/env node
/**
 * 抓取真实设备端 MCP server 的工具定义（Step 3 用）。
 *
 * 直接把 `@wonderwhy-er/desktop-commander` 的 dist 当 stdio server 跑起来，
 * 发 initialize + tools/list，把返回的 name/description/inputSchema 原样存成
 * JSON。这样 ChatGPT 侧看到的 29 个工具与设备端完全一致，零手抄。
 *
 * 用法：
 *   node scripts/capture-tools.mjs [path-to-desktop-commander-root]
 * 输出：
 *   tools.captured.json（仓库根目录）
 */
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function resolveServerRoot() {
  const fromArg = process.argv[2];
  if (fromArg) return path.resolve(fromArg);
  // 优先 npx 缓存里已构建好的发布版，其次本地仓库 dist
  const candidates = globSync(path.join(os.homedir(), ".npm/_npx/*/node_modules/@wonderwhy-er/desktop-commander"));
  for (const c of candidates) {
    if (existsSync(path.join(c, "dist/index.js"))) return c;
  }
  try {
    const pkg = require.resolve("@wonderwhy-er/desktop-commander/package.json");
    if (existsSync(path.join(path.dirname(pkg), "dist/index.js"))) return path.dirname(pkg);
  } catch {}
  const local = "/Users/guolei/Documents/默认项目/DesktopCommanderMCP";
  if (existsSync(path.join(local, "dist/index.js"))) return local;
  throw new Error("找不到 desktop-commander 构建产物（先跑一次 npx @wonderwhy-er/desktop-commander remote）");
}

const root = resolveServerRoot();
const entry = path.join(root, "dist/index.js");
if (!existsSync(entry)) throw new Error(`入口不存在: ${entry}`);

console.log(`# 从 ${entry} 抓取 tools/list`);

const child = spawn(process.execPath, [entry, "--no-onboarding"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

child.stderr.on("data", (d) => {
  const s = d.toString("utf8").trim();
  if (s) console.error(`[stderr] ${s.slice(0, 400)}`);
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc ${method} 超时`));
    }, 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "rdc-capture", version: "0.0.1" },
});
if (init.error) throw new Error("initialize 失败: " + JSON.stringify(init.error));
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const listed = await rpc("tools/list", {});
if (listed.error) throw new Error("tools/list 失败: " + JSON.stringify(listed.error));

const tools = listed.result.tools;
console.log(`# 拿到 ${tools.length} 个工具：`);
for (const t of tools) console.log(`   - ${t.name}`);

const out = fileURLToPath(new URL("../tools.captured.json", import.meta.url));
writeFileSync(out, JSON.stringify(tools, null, 2));
console.log(`# 已写出 ${out}`);

child.kill("SIGKILL");
process.exit(0);
