export async function discoverAll(registry, offlineThresholdMs) {
    return registry.discover(offlineThresholdMs);
}
export async function whois(registry, agentId, offlineThresholdMs) {
    return registry.findAgent(agentId, offlineThresholdMs);
}
