import type { RegistryEntry } from "./types.js";
import type { BridgeRegistry } from "./registry.js";
export declare function discoverAll(registry: BridgeRegistry, offlineThresholdMs: number): Promise<RegistryEntry[]>;
export declare function whois(registry: BridgeRegistry, agentId: string, offlineThresholdMs: number): Promise<RegistryEntry | null>;
