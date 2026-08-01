export interface RuntimeCommand {
  requestId: string;
  runtimeId: string;
  code: string;
}

export interface RuntimeCommandResult {
  requestId: string;
  runtimeId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeTransport {
  send(command: RuntimeCommand): Promise<RuntimeCommandResult>;
}

export class PendingRuntimeTransport implements RuntimeTransport {
  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    return {
      requestId: command.requestId,
      runtimeId: command.runtimeId,
      success: false,
      error: "Runtime transport is not connected yet.",
    };
  }
}
