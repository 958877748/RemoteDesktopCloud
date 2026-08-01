export interface RuntimeSession {
  runtimeId: string;
  connectedAt: string;
  lastHeartbeat: string;
}

const sessions = new Map<string, RuntimeSession>();

export function connectRuntime(runtimeId: string) {
  const now = new Date().toISOString();
  const session = {
    runtimeId,
    connectedAt: now,
    lastHeartbeat: now,
  };
  sessions.set(runtimeId, session);
  return session;
}

export function heartbeatRuntime(runtimeId: string) {
  const session = sessions.get(runtimeId);
  if (!session) return null;

  session.lastHeartbeat = new Date().toISOString();
  return session;
}

export function getRuntimeSession(runtimeId: string) {
  return sessions.get(runtimeId) ?? null;
}

export function listRuntimeSessions() {
  return Array.from(sessions.values());
}
