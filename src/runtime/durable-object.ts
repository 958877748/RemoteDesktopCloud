import { DurableObject } from "cloudflare:workers";

interface RuntimeCommand {
  requestId: string;
  runtimeId: string;
  code: string;
}

interface RuntimeResult {
  requestId: string;
  runtimeId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export class RuntimeSession extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private pending = new Map<string, (result: RuntimeResult) => void>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.socket = server;

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/command") {
      const command = await request.json() as RuntimeCommand;

      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return Response.json({
          requestId: command.requestId,
          runtimeId: command.runtimeId,
          success: false,
          error: "Runtime WebSocket is not connected.",
        }, { status: 503 });
      }

      const result = await new Promise<RuntimeResult>((resolve) => {
        this.pending.set(command.requestId, resolve);
        this.send({
          type: "execute",
          requestId: command.requestId,
          runtimeId: command.runtimeId,
          code: command.code,
        });
      });

      return Response.json(result);
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    let payload: Record<string, unknown>;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (payload.type === "heartbeat") {
      this.send({ type: "heartbeat_ack", timestamp: new Date().toISOString() });
      return;
    }

    if (payload.type === "result" && typeof payload.requestId === "string") {
      const resolve = this.pending.get(payload.requestId);
      if (!resolve) return;

      this.pending.delete(payload.requestId);
      resolve({
        requestId: payload.requestId,
        runtimeId: String(payload.runtimeId ?? ""),
        success: payload.success === true,
        result: payload.result,
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (this.socket === ws) this.socket = null;
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

export interface Env {
  RUNTIME_SESSIONS: DurableObjectNamespace<RuntimeSession>;
}
