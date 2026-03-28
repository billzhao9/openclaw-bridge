import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { BridgeConfig, RegistryEntry, ChannelInfo, PluginLogger } from "./types.js";
import type { BridgeRegistry } from "./registry.js";
import type { BridgeFileOps } from "./file-ops.js";

export class BridgeHeartbeat {
  private config: BridgeConfig;
  private registry: BridgeRegistry;
  private fileOps: BridgeFileOps;
  private logger: PluginLogger;
  private entry: RegistryEntry;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastConfigHash: string = "";
  private configPath: string | undefined;

  constructor(
    config: BridgeConfig,
    registry: BridgeRegistry,
    fileOps: BridgeFileOps,
    entry: RegistryEntry,
    logger: PluginLogger,
  ) {
    this.config = config;
    this.registry = registry;
    this.fileOps = fileOps;
    this.entry = entry;
    this.logger = logger;
    this.configPath = process.env.OPENCLAW_CONFIG_PATH;
    this.lastConfigHash = this.computeEntryHash();
  }

  private computeEntryHash(): string {
    const data = {
      agentId: this.entry.agentId,
      agentName: this.entry.agentName,
      port: this.entry.port,
      workspacePath: this.entry.workspacePath,
      discordId: this.entry.discordId,
      role: this.entry.role,
      capabilities: this.entry.capabilities,
    };
    return createHash("md5").update(JSON.stringify(data)).digest("hex");
  }

  async start(): Promise<void> {
    await this.registry.register(this.entry);
    this.lastConfigHash = this.computeEntryHash();

    const intervalMs = this.config.heartbeatIntervalMs ?? 30_000;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        this.logger.warn(`openclaw-bridge: heartbeat tick failed: ${String(err)}`),
      );
    }, intervalMs);

    this.logger.info(
      `openclaw-bridge: heartbeat started (${intervalMs / 1000}s interval)`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.registry.deregister(this.entry.agentId);
    this.logger.info("openclaw-bridge: heartbeat stopped, deregistered");
  }

  private async tick(): Promise<void> {
    await this.detectConfigChanges();

    this.entry.lastHeartbeat = new Date().toISOString();
    this.entry.memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    this.entry.supportsVision = this.detectVisionSupport();

    const currentHash = this.computeEntryHash();
    if (currentHash !== this.lastConfigHash) {
      this.logger.info("openclaw-bridge: config change detected, updating registry");
      await this.registry.update(this.entry);
      this.lastConfigHash = currentHash;
    } else {
      await this.registry.update(this.entry);
    }

    await this.fileOps.processPendingFiles();
    await this.fileOps.processPendingCommands();
  }

  private detectVisionSupport(): boolean {
    if (this.config.supportsVision !== undefined) {
      return this.config.supportsVision;
    }
    if (!this.configPath) return false;
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const config = JSON.parse(raw) as {
        models?: {
          default?: string;
          list?: Array<{ id?: string; name?: string }>;
        };
      };
      const defaultModel = config.models?.default ?? "";
      const visionPatterns = [
        "gpt-4o", "gpt-4-vision", "claude-3", "claude-sonnet", "claude-opus",
        "gemini", "gemini-pro", "gemini-2", "pixtral", "llava",
      ];
      return visionPatterns.some((p) => defaultModel.toLowerCase().includes(p));
    } catch {
      return false;
    }
  }

  private async detectConfigChanges(): Promise<void> {
    if (!this.configPath) return;

    try {
      const raw = await readFile(this.configPath, "utf-8");
      const config = JSON.parse(raw) as {
        bindings?: Array<{ agentId: string; match: { channel: string; accountId: string } }>;
        channels?: {
          discord?: {
            accounts?: Record<string, { token?: string; channels?: Array<{ id?: string; channelId?: string; name?: string }> }>;
          };
        };
      };

      // Find this agent's Discord binding
      const binding = config.bindings?.find(
        (b) => b.agentId === this.entry.agentId && b.match.channel === "discord",
      );
      if (!binding) return;

      const accountId = binding.match.accountId;
      const token = config.channels?.discord?.accounts?.[accountId]?.token;
      if (!token) return;

      // Extract Discord user ID from token (first segment is base64-encoded user ID)
      const firstSegment = token.split(".")[0];
      try {
        const decoded = Buffer.from(firstSegment, "base64").toString("utf-8");
        if (/^\d+$/.test(decoded) && decoded !== this.entry.discordId) {
          this.entry.discordId = decoded;
          this.logger.info(`openclaw-bridge: discordId detected: ${decoded}`);
        }
      } catch {
        // Token decode failed — skip
      }
      this.entry.discordConnected = !!this.entry.discordId;

      const channels = this.extractChannels(this.configPath);
      this.entry.channels = channels;
    } catch {
      // Config read failed — skip this cycle
    }
  }

  private extractChannels(configPath: string): ChannelInfo[] {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as {
        channels?: {
          discord?: {
            accounts?: Array<{
              channels?: Array<{ id?: string; channelId?: string; name?: string }>;
            }>;
          };
        };
      };

      const accounts = config.channels?.discord?.accounts;
      if (!Array.isArray(accounts)) return [];

      const result: ChannelInfo[] = [];
      for (const account of accounts) {
        if (!Array.isArray(account.channels)) continue;
        for (const ch of account.channels) {
          const channelId = ch.channelId ?? ch.id ?? "";
          const name = ch.name ?? channelId;
          if (channelId) {
            result.push({ type: "discord", channelId, name });
          }
        }
      }
      return result;
    } catch {
      return [];
    }
  }
}
