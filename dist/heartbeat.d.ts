import type { BridgeConfig, RegistryEntry, PluginLogger } from "./types.js";
import type { BridgeRegistry } from "./registry.js";
import type { BridgeFileOps } from "./file-ops.js";
export declare class BridgeHeartbeat {
    private config;
    private registry;
    private fileOps;
    private logger;
    private entry;
    private timer;
    private lastConfigHash;
    private configPath;
    constructor(config: BridgeConfig, registry: BridgeRegistry, fileOps: BridgeFileOps, entry: RegistryEntry, logger: PluginLogger);
    private computeEntryHash;
    start(): Promise<void>;
    stop(): Promise<void>;
    private tick;
    private detectVisionSupport;
    private detectConfigChanges;
    private extractChannels;
}
