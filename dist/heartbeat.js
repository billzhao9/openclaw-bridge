import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export class BridgeHeartbeat {
    config;
    registry;
    fileOps;
    logger;
    entry;
    timer = null;
    lastConfigHash = "";
    configPath;
    constructor(config, registry, fileOps, entry, logger) {
        this.config = config;
        this.registry = registry;
        this.fileOps = fileOps;
        this.entry = entry;
        this.logger = logger;
        this.configPath = process.env.OPENCLAW_CONFIG_PATH
            || join(homedir(), '.openclaw', 'openclaw.json');
        this.lastConfigHash = this.computeEntryHash();
    }
    computeEntryHash() {
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
    async start() {
        // Detect channels/discordId before first registration so Hub sees them immediately
        await this.detectConfigChanges();
        await this.registry.register(this.entry);
        this.lastConfigHash = this.computeEntryHash();
        const intervalMs = this.config.heartbeatIntervalMs ?? 30_000;
        this.timer = setInterval(() => {
            this.tick().catch((err) => this.logger.warn(`openclaw-bridge: heartbeat tick failed: ${String(err)}`));
        }, intervalMs);
        this.logger.info(`openclaw-bridge: heartbeat started (${intervalMs / 1000}s interval)`);
    }
    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.registry.deregister(this.entry.agentId);
        this.logger.info("openclaw-bridge: heartbeat stopped, deregistered");
    }
    async tick() {
        await this.detectConfigChanges();
        this.entry.lastHeartbeat = new Date().toISOString();
        this.entry.memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        this.entry.supportsVision = this.detectVisionSupport();
        const currentHash = this.computeEntryHash();
        if (currentHash !== this.lastConfigHash) {
            this.logger.info("openclaw-bridge: config change detected, updating registry");
            await this.registry.update(this.entry);
            this.lastConfigHash = currentHash;
        }
        else {
            await this.registry.update(this.entry);
        }
        await this.fileOps.processPendingFiles();
        await this.fileOps.processPendingCommands();
    }
    detectVisionSupport() {
        // Explicit config override takes priority
        if (this.config.supportsVision !== undefined) {
            return this.config.supportsVision;
        }
        if (!this.configPath)
            return true; // Default to true — most models support vision
        try {
            const raw = readFileSync(this.configPath, "utf-8");
            const config = JSON.parse(raw);
            const defaultModel = (config.models?.default ?? "").toLowerCase();
            if (!defaultModel)
                return true;
            // Known text-only models that do NOT support vision
            const textOnlyPatterns = [
                "minimax", "m2.7", "deepseek-r1", "deepseek-v2", "qwen-turbo",
                "yi-lightning", "glm-3", "glm-4-flash", "mistral-small",
                "codestral", "command-r", "phi-3-mini", "phi-3-small",
            ];
            return !textOnlyPatterns.some((p) => defaultModel.includes(p));
        }
        catch {
            return true;
        }
    }
    async detectConfigChanges() {
        if (!this.configPath)
            return;
        try {
            const raw = await readFile(this.configPath, "utf-8");
            const config = JSON.parse(raw);
            // Find this agent's Discord binding
            const binding = config.bindings?.find((b) => b.agentId === this.entry.agentId && b.match.channel === "discord");
            let token;
            if (binding) {
                const accountId = binding.match.accountId;
                token = config.channels?.discord?.accounts?.[accountId]?.token;
            }
            else {
                // Fallback: use first enabled Discord account when no bindings configured
                const accounts = config.channels?.discord?.accounts;
                if (accounts) {
                    const firstAccount = Object.values(accounts).find((a) => a.token);
                    token = firstAccount?.token;
                }
            }
            if (!token)
                return;
            // Extract Discord user ID from token (first segment is base64-encoded user ID)
            const firstSegment = token.split(".")[0];
            try {
                const decoded = Buffer.from(firstSegment, "base64").toString("utf-8");
                if (/^\d+$/.test(decoded) && decoded !== this.entry.discordId) {
                    this.entry.discordId = decoded;
                    this.logger.info(`openclaw-bridge: discordId detected: ${decoded}`);
                }
            }
            catch {
                // Token decode failed — skip
            }
            this.entry.discordConnected = !!this.entry.discordId;
            const channels = this.extractChannels(this.configPath);
            this.entry.channels = channels;
        }
        catch {
            // Config read failed — skip this cycle
        }
    }
    extractChannels(configPath) {
        try {
            const raw = readFileSync(configPath, "utf-8");
            const config = JSON.parse(raw);
            const accounts = config.channels?.discord?.accounts;
            if (!accounts || typeof accounts !== "object")
                return [];
            const result = [];
            const seen = new Set();
            for (const account of Object.values(accounts)) {
                // Format 1: guilds.<guildId>.channels.<channelId> (standard openclaw.json)
                if (account.guilds && typeof account.guilds === "object") {
                    for (const guild of Object.values(account.guilds)) {
                        if (guild.channels && typeof guild.channels === "object") {
                            for (const channelId of Object.keys(guild.channels)) {
                                if (channelId && !seen.has(channelId)) {
                                    seen.add(channelId);
                                    result.push({ type: "discord", channelId, name: channelId });
                                }
                            }
                        }
                    }
                }
                // Format 2: channels array (legacy / alternative format)
                if (Array.isArray(account.channels)) {
                    for (const ch of account.channels) {
                        const channelId = ch.channelId ?? ch.id ?? "";
                        if (channelId && !seen.has(channelId)) {
                            seen.add(channelId);
                            result.push({ type: "discord", channelId, name: ch.name ?? channelId });
                        }
                    }
                }
            }
            return result;
        }
        catch {
            return [];
        }
    }
}
