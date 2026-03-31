import type { ProjectManager } from "./project-manager.js";
import type { PluginLogger } from "./types.js";

export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
  level?: "soft" | "hard" | "project";
}

const HARD_LIMIT_PER_TASK = 15;
const PROJECT_TOTAL_LIMIT = 30;

export class CircuitBreaker {
  private pm: ProjectManager;
  private logger: PluginLogger;

  constructor(pm: ProjectManager, logger: PluginLogger) {
    this.pm = pm;
    this.logger = logger;
  }

  /**
   * Check and increment rounds for a task. Returns whether communication is allowed.
   * This is the HARD enforcement layer — overrides PM judgment.
   */
  checkAndIncrement(projectId: string, taskId: string): CircuitBreakerResult {
    const result = this.pm.incrementRounds(projectId, taskId);
    if (!result) return { allowed: true };

    const project = this.pm.readProject(projectId);

    // Hard per-task limit (15 rounds) — non-negotiable
    if (result.hardLimit) {
      this.logger.warn(`[circuit-breaker] HARD LIMIT: task ${taskId} in project ${projectId} hit ${result.task.rounds} rounds`);
      this.pm.updateTaskStatus(projectId, taskId, "blocked", {
        blockType: "dependency_failed",
        blockReason: `Circuit breaker: task exceeded ${HARD_LIMIT_PER_TASK} rounds`,
      });
      return {
        allowed: false,
        reason: `Task ${taskId} force-stopped: exceeded ${HARD_LIMIT_PER_TASK} communication rounds. Human intervention required.`,
        level: "hard",
      };
    }

    // Project total limit (30 rounds)
    if (project && project.totalRounds >= PROJECT_TOTAL_LIMIT) {
      this.logger.warn(`[circuit-breaker] PROJECT LIMIT: project ${projectId} hit ${project.totalRounds} total rounds`);
      return {
        allowed: false,
        reason: `Project "${project.name}" total communication exceeded ${PROJECT_TOTAL_LIMIT} rounds. Pausing for human review.`,
        level: "project",
      };
    }

    // Soft per-task limit (8 rounds) — warning, PM should handle
    if (result.softLimit) {
      return {
        allowed: true,
        reason: `Warning: task ${taskId} has reached ${result.task.rounds} rounds (soft limit: ${result.task.maxRounds})`,
        level: "soft",
      };
    }

    return { allowed: true };
  }
}
