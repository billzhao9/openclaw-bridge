import type { BridgeConfig, RegistryEntry, PluginLogger } from "./types.js";
import type { BridgeRegistry } from "./registry.js";
export declare class BridgeRestart {
    private config;
    private machineId;
    private registry;
    private logger;
    constructor(config: BridgeConfig, machineId: string, registry: BridgeRegistry, logger: PluginLogger);
    restart(target: RegistryEntry): Promise<{
        success: boolean;
        message: string;
    }>;
    private restartLocal;
    private restartRemote;
}
