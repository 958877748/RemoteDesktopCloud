/**
 * Step 3/4 — `/mcp` 的 MCP 服务端：静态注册 29 个工具 + 分发。
 *
 * 用低层 `Server` 而不是 `McpServer`：`McpServer.registerTool` 要求
 * StandardSchema（zod），而我们手里是从设备端抓来的原生 JSON Schema，
 * 低层 `setRequestHandler('tools/list', …)` 可以原样透传，零转换。
 *
 * 分发：
 *   - `who_am_i` / `list_devices` —— 云端直答（读 env / `mcp_devices`）
 *   - 其余 27 个 —— 投递到在线设备执行（`calls.ts`，Step 4）
 */
import { Server, type CallToolResult } from "@modelcontextprotocol/server";
import { dispatchCall } from "./calls.js";
import type { Env } from "./env.js";
import { listDevices } from "./supabase.js";
import { TOOLS } from "./tools.js";

export const SERVER_NAME = "remotedesktopcloud";
export const SERVER_VERSION = "0.1.0";

type Result = CallToolResult;

function ok(payload: unknown): Result {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(text: string): Result {
  return { content: [{ type: "text", text }], isError: true };
}

async function callTool(env: Env, props: Record<string, unknown>, name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<Result> {
  switch (name) {
    case "who_am_i":
      return ok({
        userId: (props.userId as string) ?? env.USER_ID,
        email: (props.email as string) ?? env.USER_EMAIL,
        note: "RemoteDesktopCloud 是单用户中转站，所有 OAuth token 都绑定这一个身份。",
      });

    case "list_devices": {
      const rows = await listDevices(env);
      if (!rows.length) {
        return ok({ devices: [], note: "还没有设备配对。在机器上运行 npx @wonderwhy-er/desktop-commander remote 完成配对。" });
      }
      return ok({
        devices: rows.map((r) => ({
          id: r.id,
          name: r.device_name,
          status: r.status,
          last_seen: r.last_seen,
          capabilities: r.capabilities,
        })),
      });
    }

    default:
      // 转发到设备执行。`_meta.device_id` 可选地指定投递给哪台机器。
      const deviceId = typeof meta.device_id === "string" ? meta.device_id : undefined;
      return await dispatchCall(env, { toolName: name, toolArgs: args, metadata: meta, deviceId });
  }
}

/** 构造一次请求专用的 MCP 服务端。`props` 来自 OAuth provider 解出的 grant props。 */
export function createServer(env: Env, props: Record<string, unknown>): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Desktop Commander 远程中转：工具定义与本机 Desktop Commander 完全一致，" +
        "调用会被转发到已配对的在线机器执行。",
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const meta = (request.params._meta ?? {}) as Record<string, unknown>;
    try {
      return await callTool(env, props, name, args, meta);
    } catch (err) {
      return fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return server;
}
