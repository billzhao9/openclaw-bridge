import type { PluginLogger, LocalManagerConfig } from "../types.js";
export declare class LocalManager {
    private config;
    private apiKey;
    private logger;
    private hubClient;
    private statusTimer;
    private hasLock;
    constructor(config: LocalManagerConfig, apiKey: string, logger: PluginLogger);
    start(): Promise<void>;
    stop(): Promise<void>;
}
