import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "cloudflare-html2sprite-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "sprite_test",
    {
      description: "A simple test tool for the Cloudflare html2sprite MCP server.",
      inputSchema: {
        message: z.string().default("hello"),
      },
    },
    async ({ message }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message,
            server: "cloudflare-html2sprite-mcp",
            timestamp: new Date().toISOString(),
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
        name: "cloudflare-html2sprite-mcp",
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
