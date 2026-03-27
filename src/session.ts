export interface ProxySession {
  sessionId: string;
  originAgent: string;
  currentAgent: string;
  currentAgentName: string;
}

let activeSession: ProxySession | null = null;

export function setSession(session: ProxySession): void {
  activeSession = session;
  console.log(`[session] SET handoff: sessionId=${session.sessionId} target=${session.currentAgent}`);
}

export function getSession(): ProxySession | null {
  return activeSession;
}

export function clearSession(): void {
  console.log(`[session] CLEAR handoff (was: ${activeSession?.sessionId || 'none'})`);
  activeSession = null;
}

export function updateCurrentAgent(agentId: string, agentName: string): void {
  if (activeSession) {
    activeSession.currentAgent = agentId;
    activeSession.currentAgentName = agentName;
  }
}

export function isInHandoff(): boolean {
  return activeSession !== null;
}
