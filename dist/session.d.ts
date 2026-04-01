export interface ProxySession {
    sessionId: string;
    originAgent: string;
    currentAgent: string;
    currentAgentName: string;
}
export declare function setSession(session: ProxySession): void;
export declare function getSession(): ProxySession | null;
export declare function clearSession(): void;
export declare function updateCurrentAgent(agentId: string, agentName: string): void;
export declare function isInHandoff(): boolean;
