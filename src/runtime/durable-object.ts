import { DurableObject } from "cloudflare:workers";

interface RuntimeCommand {
  requestId: string;
  runtimeId: string;
  code: string;
}

export class RuntimeSession extends DurableObject<Env> {
  private socket: WebSocket | null = null;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.socket = server;

    server.addEventListener("message", (event) => {
      this.handleMessage(String(event.data));
    });

    server.addEventListener("close", () => {
      if (this.socket === server) {
        this.socket = null;
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    await this.handleMessage(
      typeof message === "string" ? message : new TextDecoder().decode(message),
    );
  }

  async webSocketClose(ws: WebSocket) {
    if (this.socket === ws) {
      this.socket = null;
    }
  }

  private async handleMessage(raw: string) {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type === "heartbeat") {
      this.send({ type: "heartbeat_ack", timestamp: new Date().toISOString() });
      return;
    }

    if (message.type === "result") {
      return;
    }
  }

  async sendCommand(command: RuntimeCommand): Promise<void> {
    if (!this.socket) {
      throw new Error("Runtime WebSocket is not connected.");
    }

    this.send({
      type: "execute",
      requestId: command.requestId,
      runtimeId: command.runtimeId,
      code: command.code,
    });
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
