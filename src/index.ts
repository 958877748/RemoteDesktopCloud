import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RuntimeSession } from "./runtime/durable-object";

function createServer(env: Env) {
  const server = new McpServer({ name: "personal-agent-mcp", version: "0.1.0" });

  server.registerTool("runtime_info", {
    description: "Get the connection status of a local Personal Agent Runtime.",
    inputSchema: { runtimeId: z.string().min(1) },
  }, async ({ runtimeId }) => {
    const id = env.RUNTIME_SESSIONS.idFromName(runtimeId);
    const response = await env.RUNTIME_SESSIONS.get(id).fetch("https://runtime-session/status");
    return { content: [{ type: "text", text: JSON.stringify(await response.json()) }] };
  });

  server.registerTool("discover", {
    description: "Discover a local runtime and its capabilities.",
    inputSchema: { runtimeId: z.string().min(1) },
  }, async ({ runtimeId }) => {
    const id = env.RUNTIME_SESSIONS.idFromName(runtimeId);
    const response = await env.RUNTIME_SESSIONS.get(id).fetch("https://runtime-session/status");
    return { content: [{ type: "text", text: JSON.stringify(await response.json()) }] };
  });

  server.registerTool("execute_runtime", {
    description: "Execute JavaScript on a connected user's local Personal Agent Runtime.",
    inputSchema: {
      runtimeId: z.string().min(1),
      code: z.string().min(1),
    },
  }, async ({ runtimeId, code }) => {
    const id = env.RUNTIME_SESSIONS.idFromName(runtimeId);
    const stub = env.RUNTIME_SESSIONS.get(id);
    const requestId = crypto.randomUUID();
    const response = await stub.fetch("https://runtime-session/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, runtimeId, code }),
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(await response.json()),
      }],
    };
  });

  return server;
}

const mcpHandler = (request: Request, env: Env, ctx: ExecutionContext) =>
  createMcpHandler(() => createServer(env))(request, env, ctx);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") return mcpHandler(request, env, ctx);

    if (url.pathname.startsWith("/runtime/")) {
      const runtimeId = decodeURIComponent(url.pathname.slice("/runtime/".length));
      if (!runtimeId) return new Response("Missing runtime ID", { status: 400 });
      const id = env.RUNTIME_SESSIONS.idFromName(runtimeId);
      return env.RUNTIME_SESSIONS.get(id).fetch(request);
    }

    return Response.json({
      name: "personal-agent-mcp",
      status: "ok",
      mcpEndpoint: "/mcp",
      runtimeWebSocketEndpoint: "/runtime/{runtimeId}",
    });
  },
};

export { RuntimeSession };

interface Env {
  RUNTIME_SESSIONS: DurableObjectNamespace<RuntimeSession>;
}
