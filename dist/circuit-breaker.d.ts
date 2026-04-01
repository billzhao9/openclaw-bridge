import type { ProjectManager } from "./project-manager.js";
import type { PluginLogger } from "./types.js";
export interface CircuitBreakerResult {
    allowed: boolean;
    reason?: string;
    level?: "soft" | "hard" | "project";
}
export declare class CircuitBreaker {
    private pm;
    private logger;
    constructor(pm: ProjectManager, logger: PluginLogger);
    /**
     * Check and increment rounds for a task. Returns whether communication is allowed.
     * This is the HARD enforcement layer — overrides PM judgment.
     */
    checkAndIncrement(projectId: string, taskId: string): CircuitBreakerResult;
}
