let activeSession = null;
export function setSession(session) {
    activeSession = session;
    console.log(`[session] SET handoff: sessionId=${session.sessionId} target=${session.currentAgent}`);
}
export function getSession() {
    return activeSession;
}
export function clearSession() {
    console.log(`[session] CLEAR handoff (was: ${activeSession?.sessionId || 'none'})`);
    activeSession = null;
}
export function updateCurrentAgent(agentId, agentName) {
    if (activeSession) {
        activeSession.currentAgent = agentId;
        activeSession.currentAgentName = agentName;
    }
}
export function isInHandoff() {
    return activeSession !== null;
}
