import type { BridgeConfig, RegistryEntry, PluginLogger } from "./types.js";
export declare class BridgeRegistry {
    private baseUrl;
    private apiKey;
    private logger;
    constructor(config: BridgeConfig, logger: PluginLogger);
    private headers;
    register(entry: RegistryEntry): Promise<void>;
    update(entry: RegistryEntry): Promise<void>;
    deregister(agentId: string): Promise<void>;
    discover(offlineThresholdMs: number): Promise<RegistryEntry[]>;
    findAgent(agentId: string, offlineThresholdMs: number): Promise<RegistryEntry | null>;
}
