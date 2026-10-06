import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./env.js";
import { requireEnv } from "./env.js";
import {
  handleDevicePoll,
  handleDeviceStart,
  handleDeviceVerify,
  handleMcpInfo,
} from "./device-auth.js";

/**
 * MCP 服务端。Step 3 会在这里静态注册 29 个 DesktopCommander 工具；
 * 目前先挂空壳，保证 /mcp 的 Streamable HTTP 传输与骨架可用。
 *
 * 注意：McpServer 必须来自 `@modelcontextprotocol/server`（agents/mcp/server 的
 * createMcpHandler 期望的就是这一份类型），不能用 `@modelcontextprotocol/sdk`。
 */
function createServer(_env: Env): McpServer {
  return new McpServer({ name: "remotedesktopcloud", version: "0.1.0" });
}

const mcpHandler = (request: Request, env: Env, ctx: ExecutionContext) =>
  createMcpHandler(() => createServer(env))(request, env, ctx);

function error(message: string, status = 500): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    try {
      requireEnv(env);
    } catch (e: any) {
      return error(`Configuration error: ${e.message}`, 500);
    }

    switch (pathname) {
      case "/mcp":
        return mcpHandler(request, env, ctx);

      case "/api/mcp-info":
        return handleMcpInfo(request, env);

      case "/device/start":
        return request.method === "POST"
          ? handleDeviceStart(request, env)
          : error("Method not allowed", 405);

      case "/device/verify":
        return request.method === "GET" || request.method === "POST"
          ? handleDeviceVerify(request, env)
          : error("Method not allowed", 405);

      case "/device/poll":
        return request.method === "POST"
          ? handleDevicePoll(request, env)
          : error("Method not allowed", 405);

      case "/":
        return Response.json({
          name: "remotedesktopcloud",
          status: "ok",
          endpoints: ["/mcp", "/api/mcp-info", "/device/start", "/device/verify", "/device/poll"],
        });

      default:
        return error("Not found", 404);
    }
  },
};
