import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listRuntimes, registerRuntime } from "./runtime/registry";

function createServer() {
  const server = new McpServer({
    name: "personal-agent-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "runtime_info",
    {
      description: "Get personal agent runtime information.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: "personal-agent-mcp",
            type: "runtime-controller",
            version: "0.1.0",
            connectedRuntimes: listRuntimes().length,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "register_runtime",
    {
      description: "Register a user's local personal agent runtime.",
      inputSchema: {
        id: z.string(),
        capabilities: z.array(z.string()).default([]),
      },
    },
    async ({ id, capabilities }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            registerRuntime({
              id,
              capabilities,
              lastSeen: new Date().toISOString(),
            }),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "discover",
    {
      description: "Discover connected runtime capabilities.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runtimes: listRuntimes(),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "execute_runtime",
    {
      description: "Execute code on a connected local runtime (placeholder).",
      inputSchema: {
        runtimeId: z.string(),
        code: z.string(),
      },
    },
    async ({ runtimeId, code }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            accepted: true,
            runtimeId,
            code,
            status: "queued",
          }),
        },
      ],
    }),
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return new Response(
      JSON.stringify({
        name: "personal-agent-mcp",
        status: "ok",
        mcpEndpoint: "/mcp",
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  },
};

interface Env {
  [key: string]: unknown;
}
