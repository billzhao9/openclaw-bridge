export class BridgeRegistry {
    baseUrl;
    apiKey;
    logger;
    constructor(config, logger) {
        // Use fileRelay URL for registry (not OpenViking)
        if (!config.fileRelay?.baseUrl) {
            throw new Error("openclaw-bridge: fileRelay.baseUrl is required for registry");
        }
        this.baseUrl = config.fileRelay.baseUrl.replace(/\/+$/, "");
        this.apiKey = config.fileRelay.apiKey;
        this.logger = logger;
    }
    headers() {
        const h = { "Content-Type": "application/json" };
        if (this.apiKey)
            h["X-API-Key"] = this.apiKey;
        return h;
    }
    async register(entry) {
        try {
            const res = await fetch(`${this.baseUrl}/api/v1/registry/register`, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify(entry),
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            this.logger.info(`openclaw-bridge: registered ${entry.agentId} to registry`);
        }
        catch (err) {
            this.logger.error(`openclaw-bridge: registration failed: ${String(err)}`);
            throw err;
        }
    }
    async update(entry) {
        try {
            const res = await fetch(`${this.baseUrl}/api/v1/registry/heartbeat`, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify(entry),
            });
            if (!res.ok) {
                await this.register(entry);
                return;
            }
            // Check for registry-level agentId conflict
            const body = await res.json();
            if (body.error === "agentId_conflict") {
                this.logger.warn(`openclaw-bridge: registry conflict — agentId "${entry.agentId}" belongs to machine "${body.existingMachine}", skipping heartbeat`);
                // Don't re-register — the WebSocket conflict handler will rename us
            }
        }
        catch (err) {
            this.logger.warn(`openclaw-bridge: heartbeat failed, re-registering: ${String(err)}`);
            await this.register(entry);
        }
    }
    async deregister(agentId) {
        try {
            await fetch(`${this.baseUrl}/api/v1/registry/${agentId}`, {
                method: "DELETE",
                headers: this.headers(),
            });
            this.logger.info(`openclaw-bridge: deregistered ${agentId}`);
        }
        catch (err) {
            this.logger.warn(`openclaw-bridge: deregistration failed: ${String(err)}`);
        }
    }
    async discover(offlineThresholdMs) {
        try {
            const res = await fetch(`${this.baseUrl}/api/v1/registry/discover`, {
                headers: this.headers(),
            });
            if (!res.ok)
                return [];
            const data = (await res.json());
            const now = Date.now();
            return (data.agents ?? []).map((entry) => {
                const lastBeat = new Date(entry.lastHeartbeat).getTime();
                entry.status = (now - lastBeat > offlineThresholdMs) ? "offline" : "online";
                return entry;
            });
        }
        catch (err) {
            this.logger.error(`openclaw-bridge: discover failed: ${String(err)}`);
            return [];
        }
    }
    async findAgent(agentId, offlineThresholdMs) {
        try {
            const res = await fetch(`${this.baseUrl}/api/v1/registry/whois/${agentId}`, {
                headers: this.headers(),
            });
            if (!res.ok)
                return null;
            const entry = (await res.json());
            const now = Date.now();
            const lastBeat = new Date(entry.lastHeartbeat).getTime();
            entry.status = (now - lastBeat > offlineThresholdMs) ? "offline" : "online";
            return entry;
        }
        catch {
            return null;
        }
    }
}
