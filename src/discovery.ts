import type { RegistryEntry } from "./types.js";
import type { BridgeRegistry } from "./registry.js";

export async function discoverAll(
  registry: BridgeRegistry,
  offlineThresholdMs: number,
): Promise<RegistryEntry[]> {
  return registry.discover(offlineThresholdMs);
}

export async function whois(
  registry: BridgeRegistry,
  agentId: string,
  offlineThresholdMs: number,
): Promise<RegistryEntry | null> {
  return registry.findAgent(agentId, offlineThresholdMs);
}
