import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listRuntimes, registerRuntime } from "./runtime/registry";
import {
  connectRuntime,
  getRuntimeSession,
  heartbeatRuntime,
  listRuntimeSessions,
} from "./runtime/session";
import { PendingRuntimeTransport } from "./runtime/transport";

const transport = new PendingRuntimeTransport();

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
            activeSessions: listRuntimeSessions().length,
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
        id: z.string().min(1),
        capabilities: z.array(z.string()).default([]),
      },
    },
    async ({ id, capabilities }) => {
      const runtime = registerRuntime({
        id,
        capabilities,
        lastSeen: new Date().toISOString(),
      });
      const session = connectRuntime(id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ runtime, session }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "heartbeat_runtime",
    {
      description: "Update the heartbeat for a connected local runtime.",
      inputSchema: {
        runtimeId: z.string().min(1),
      },
    },
    async ({ runtimeId }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runtimeId,
            session: heartbeatRuntime(runtimeId),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "discover",
    {
      description: "Discover connected runtime capabilities and sessions.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runtimes: listRuntimes(),
            sessions: listRuntimeSessions(),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "execute_runtime",
    {
      description: "Execute code on a connected local runtime.",
      inputSchema: {
        runtimeId: z.string().min(1),
        code: z.string().min(1),
      },
    },
    async ({ runtimeId, code }) => {
      const session = getRuntimeSession(runtimeId);

      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accepted: false,
                runtimeId,
                status: "runtime_not_connected",
              }),
            },
          ],
        };
      }

      const result = await transport.send({
        requestId: crypto.randomUUID(),
        runtimeId,
        code,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    },
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
        runtimeSessions: listRuntimeSessions().length,
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
