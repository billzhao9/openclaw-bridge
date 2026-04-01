import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DISCORD_API = "https://discord.com/api/v10";
export class DiscordApi {
    token = null;
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    /** Extract bot token from openclaw.json config */
    loadToken() {
        const configCandidates = [
            process.env.OPENCLAW_CONFIG_PATH,
            process.env.OPENCLAW_HOME ? `${process.env.OPENCLAW_HOME}/openclaw.json` : "",
            join(homedir(), ".openclaw", "openclaw.json"),
        ].filter(Boolean);
        for (const configPath of configCandidates) {
            if (!existsSync(configPath))
                continue;
            try {
                const raw = JSON.parse(readFileSync(configPath, "utf-8"));
                const accounts = raw.channels?.discord?.accounts ?? raw.channels?.["openclaw-discord"]?.accounts ?? {};
                for (const acc of Object.values(accounts)) {
                    if (acc.token) {
                        this.token = acc.token;
                        this.logger.info("[discord-api] Bot token loaded");
                        return;
                    }
                }
            }
            catch { /* try next */ }
        }
        if (!this.token) {
            this.logger.warn("[discord-api] No Discord bot token found — thread tools will be unavailable");
        }
    }
    get isAvailable() {
        return this.token !== null;
    }
    async request(method, path, body) {
        if (!this.token)
            throw new Error("Discord API not available — no bot token");
        const res = await fetch(`${DISCORD_API}${path}`, {
            method,
            headers: {
                "Authorization": `Bot ${this.token}`,
                "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Discord API ${method} ${path} failed: ${res.status} ${text.substring(0, 200)}`);
        }
        return res.json();
    }
    /**
     * Create a public thread in a channel.
     * Returns { id, name } of the created thread.
     */
    async createThread(channelId, name, message) {
        const thread = await this.request("POST", `/channels/${channelId}/threads`, {
            name: name.substring(0, 100),
            type: 11, // PUBLIC_THREAD
            auto_archive_duration: 10080, // 7 days
        });
        if (message) {
            await this.sendMessage(thread.id, message);
        }
        this.logger.info(`[discord-api] Created thread "${name}" (${thread.id})`);
        return { id: thread.id, name: thread.name };
    }
    /**
     * Send a message to a channel or thread.
     */
    async sendMessage(channelId, content) {
        const msg = await this.request("POST", `/channels/${channelId}/messages`, {
            content: content.substring(0, 2000),
        });
        return { id: msg.id };
    }
}
