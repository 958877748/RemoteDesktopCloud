import { DurableObject } from "cloudflare:workers";

export type RuntimeStatus = "online" | "offline" | "connecting" | "busy";

export interface RuntimeStatusResponse {
  success: boolean;
  runtimeId: string;
  status: RuntimeStatus;
  connected: boolean;
  capabilities: unknown[];
  code?: "RUNTIME_OFFLINE" | "RUNTIME_NOT_REGISTERED";
  message?: string;
  userAction?: string;
}

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
  private runtimeId: string | null = null;
  private capabilities: unknown[] = [];
  private status: RuntimeStatus = "offline";
  private lastHeartbeat = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.socket = server;
      this.status = "connecting";
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/command") {
      const command = await request.json() as RuntimeCommand;
      if (!this.isOnline()) {
        return Response.json(this.offlineResponse(command.runtimeId), { status: 200 });
      }

      this.status = "busy";
      const result = await new Promise<RuntimeResult>((resolve) => {
        this.pending.set(command.requestId, resolve);
        this.send({ type: "execute", requestId: command.requestId, runtimeId: command.runtimeId, code: command.code });
      });
      this.status = "online";
      return Response.json(result);
    }

    if (request.method === "GET") {
      return Response.json(this.statusResponse());
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

    if (payload.type === "register") {
      this.runtimeId = typeof payload.runtimeId === "string" ? payload.runtimeId : null;
      this.capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
      this.status = this.runtimeId ? "online" : "offline";
      this.lastHeartbeat = Date.now();
      this.send({ type: "registered", runtimeId: this.runtimeId, status: this.status });
      return;
    }

    if (payload.type === "heartbeat") {
      this.lastHeartbeat = Date.now();
      if (this.status !== "busy") this.status = "online";
      this.send({ type: "heartbeat_ack", timestamp: new Date().toISOString() });
      return;
    }

    if (payload.type === "result" && typeof payload.requestId === "string") {
      const resolve = this.pending.get(payload.requestId);
      if (!resolve) return;
      this.pending.delete(payload.requestId);
      resolve({
        requestId: payload.requestId,
        runtimeId: String(payload.runtimeId ?? this.runtimeId ?? ""),
        success: payload.success === true,
        result: payload.result,
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (this.socket === ws) {
      this.socket = null;
      this.status = "offline";
    }
  }

  private isOnline() {
    return this.status === "online" && this.socket?.readyState === WebSocket.OPEN;
  }

  private statusResponse(): RuntimeStatusResponse {
    if (!this.runtimeId || !this.isOnline()) {
      return this.offlineResponse(this.runtimeId ?? "unknown");
    }

    return {
      success: true,
      runtimeId: this.runtimeId,
      status: this.status,
      connected: true,
      capabilities: this.capabilities,
    };
  }

  private offlineResponse(runtimeId: string): RuntimeStatusResponse {
    return {
      success: false,
      runtimeId,
      status: "offline",
      connected: false,
      capabilities: [],
      code: "RUNTIME_OFFLINE",
      message: "The local Personal Agent Runtime is not connected.",
      userAction: "Please start personal-agent-runtime on your computer, then try again.",
    };
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
