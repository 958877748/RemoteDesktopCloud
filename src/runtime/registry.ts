export interface RuntimeClient {
  id: string;
  capabilities: string[];
  lastSeen: string;
}

const runtimes = new Map<string, RuntimeClient>();

export function registerRuntime(runtime: RuntimeClient) {
  runtimes.set(runtime.id, runtime);
  return runtime;
}

export function listRuntimes() {
  return Array.from(runtimes.values());
}
