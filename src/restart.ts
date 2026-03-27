import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { BridgeConfig, RegistryEntry, PluginLogger } from "./types.js";
import type { BridgeRegistry } from "./registry.js";

const execAsync = promisify(exec);
const IS_WIN = process.platform === "win32";

export class BridgeRestart {
  private config: BridgeConfig;
  private machineId: string;
  private registry: BridgeRegistry;
  private logger: PluginLogger;

  constructor(
    config: BridgeConfig,
    machineId: string,
    registry: BridgeRegistry,
    logger: PluginLogger,
  ) {
    this.config = config;
    this.machineId = machineId;
    this.registry = registry;
    this.logger = logger;
  }

  async restart(target: RegistryEntry): Promise<{ success: boolean; message: string }> {
    if (target.machineId !== this.machineId) {
      return this.restartRemote(target);
    }
    return this.restartLocal(target);
  }

  private async restartLocal(
    target: RegistryEntry,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.info(`openclaw-bridge: restarting ${target.agentId} on local machine`);

    try {
      if (IS_WIN) {
        const { stdout } = await execAsync(
          `netstat -ano | findstr :${target.port} | findstr LISTENING`,
        );
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) {
            await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
          }
        }
      } else {
        await execAsync(`lsof -ti:${target.port} | xargs kill -9`).catch(() => {});
      }

      const instanceDir = target.workspacePath.replace(/[\\/]workspace[\\/]?$/, "");
      const runScript = IS_WIN
        ? `${instanceDir}\\run.ps1`
        : `${instanceDir}/run.sh`;

      if (IS_WIN) {
        await execAsync(
          `powershell -Command "Start-Process powershell -ArgumentList '-File','${runScript}' -WindowStyle Hidden"`,
        );
      } else {
        await execAsync(`nohup bash "${runScript}" > /dev/null 2>&1 &`);
      }

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3_000));
        const found = await this.registry.findAgent(
          target.agentId,
          this.config.offlineThresholdMs ?? 120_000,
        );
        if (found && found.status === "online") {
          this.logger.info(`openclaw-bridge: ${target.agentId} restarted successfully`);
          return { success: true, message: `${target.agentId} restarted and back online` };
        }
      }

      return {
        success: false,
        message: `${target.agentId} process started but did not re-register within 60s`,
      };
    } catch (err) {
      return { success: false, message: `Restart failed: ${String(err)}` };
    }
  }

  private async restartRemote(
    target: RegistryEntry,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.config.fileRelay?.baseUrl) {
      return {
        success: false,
        message: "Cannot restart remote gateway: fileRelay not configured",
      };
    }

    const baseUrl = this.config.fileRelay.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.fileRelay.apiKey) headers["X-API-Key"] = this.config.fileRelay.apiKey;

    const res = await fetch(`${baseUrl}/api/v1/commands/enqueue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fromAgent: this.config.agentId,
        toAgent: target.agentId,
        type: "restart",
        payload: {},
      }),
    });

    if (!res.ok) {
      return { success: false, message: `FileRelay command enqueue failed: ${res.status}` };
    }

    const { id: cmdId } = (await res.json()) as { id: string };

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const resultRes = await fetch(`${baseUrl}/api/v1/commands/result/${cmdId}`, { headers });
      if (!resultRes.ok) continue;
      const result = (await resultRes.json()) as { status: string };
      if (result.status === "ok") {
        return { success: true, message: `Restart command acknowledged by ${target.agentId}` };
      }
      if (result.status === "error") {
        return { success: false, message: `Remote restart failed` };
      }
    }

    return { success: false, message: "Restart command timed out (90s)" };
  }
}
