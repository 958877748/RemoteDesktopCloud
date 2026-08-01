import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class Html2SpriteMCP extends McpAgent {
  server = new McpServer({
    name: "cloudflare-html2sprite-mcp",
    version: "0.1.0",
  });

  async init() {
    this.server.tool(
      "sprite_test",
      "A simple test tool for the Cloudflare html2sprite MCP server.",
      {
        message: z.string().default("hello"),
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
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return Html2SpriteMCP.serve("/mcp").fetch(request, env, ctx);
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
