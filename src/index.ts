/**
 * Worker 入口。
 *
 * 所有请求先经 `@cloudflare/workers-oauth-provider`：
 *   - `/.well-known/*`、`POST /token`、`POST /register`、`/mcp` 的 Bearer 校验 → provider 内建
 *   - `/mcp`（拿到 token 后）→ `mcpApiHandler`，挂 MCP 服务端
 *   - 其余（`/device/*`、`/authorize`、`/api/*`、首页控制台）→ `defaultHandler`（下面的路由表）
 */
import { createMcpHandler } from "agents/mcp/server";
import {
  handleDevicePoll,
  handleDeviceStart,
  handleDeviceVerify,
  handleMcpInfo,
  page,
} from "./device-auth.js";
import {
  handleConsole,
  handleDevicesApi,
  handleInfo,
  handleLogin,
  handleLogout,
} from "./console.js";
import type { Env } from "./env.js";
import { requireEnv } from "./env.js";
import { createServer } from "./mcp.js";
import { getProvider, handleAuthorize, wrapProvider, type FetchHandler } from "./oauth.js";

/** `/mcp`：provider 校验完 Bearer 之后调进来，`ctx.props` 是授权时写入的 grant props。 */
const mcpApiHandler: FetchHandler = {
  fetch(request, env, ctx) {
    const props = (ctx as { props?: Record<string, unknown> }).props ?? {};
    const handler = createMcpHandler(() => createServer(env, props), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/mcp-info") return handleMcpInfo(request, env);
  if (pathname === "/api/devices" && request.method === "GET") return handleDevicesApi(request, env);
  if (pathname === "/api/devices/revoke" && request.method === "POST") return handleDevicesApi(request, env);
  if (pathname === "/api/info") return handleInfo();
  if (pathname === "/device/start" && request.method === "POST") return handleDeviceStart(request, env);
  if (pathname === "/device/poll" && request.method === "POST") return handleDevicePoll(request, env);
  if (pathname === "/device/verify") return handleDeviceVerify(request, env);
  if (pathname === "/authorize") return handleAuthorize(request, env);
  if (pathname === "/login" && request.method === "POST") return handleLogin(request, env);
  if (pathname === "/logout" && request.method === "POST") return handleLogout(request, env);

  // 首页 = 控制台（无 session 时是密码登录页）
  if (pathname === "/") return handleConsole(request, env);

  return page("未找到", `<h1>404</h1><p>没有这个路径：<code>${escapeCode(pathname)}</code></p>`, 404);
}

function escapeCode(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const defaultHandler: FetchHandler = { fetch: (request, env) => route(request, env) };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      requireEnv(env);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    const origin = new URL(request.url).origin;
    const provider = wrapProvider(getProvider(origin, mcpApiHandler, defaultHandler));
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
