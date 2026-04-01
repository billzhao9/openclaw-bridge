import type { PluginLogger } from "./types.js";
export declare class DiscordApi {
    private token;
    private logger;
    constructor(logger: PluginLogger);
    /** Extract bot token from openclaw.json config */
    loadToken(): void;
    get isAvailable(): boolean;
    private request;
    /**
     * Create a public thread in a channel.
     * Returns { id, name } of the created thread.
     */
    createThread(channelId: string, name: string, message?: string): Promise<{
        id: string;
        name: string;
    }>;
    /**
     * Send a message to a channel or thread.
     */
    sendMessage(channelId: string, content: string): Promise<{
        id: string;
    }>;
}
