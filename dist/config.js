import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const DEFAULTS = {
    heartbeatIntervalMs: 30_000,
    offlineThresholdMs: 120_000,
};
export function parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("openclaw-bridge: missing plugin config");
    }
    const obj = raw;
    if (!obj.role || (obj.role !== "normal" && obj.role !== "superuser")) {
        throw new Error('openclaw-bridge: config.role must be "normal" or "superuser"');
    }
    if (!obj.agentId || typeof obj.agentId !== "string") {
        throw new Error("openclaw-bridge: config.agentId is required");
    }
    if (!obj.agentName || typeof obj.agentName !== "string") {
        throw new Error("openclaw-bridge: config.agentName is required");
    }
    const registry = obj.registry;
    if (!registry || !registry.baseUrl || typeof registry.baseUrl !== "string") {
        throw new Error("openclaw-bridge: config.registry.baseUrl is required");
    }
    return {
        role: obj.role,
        isProjectManager: obj.isProjectManager === true,
        agentId: obj.agentId,
        agentName: obj.agentName,
        registry: {
            provider: registry.provider ?? "openviking",
            baseUrl: registry.baseUrl,
            apiKey: registry.apiKey,
        },
        fileRelay: obj.fileRelay
            ? {
                baseUrl: obj.fileRelay.baseUrl,
                apiKey: obj.fileRelay.apiKey,
            }
            : undefined,
        messageRelay: obj.messageRelay
            ? {
                url: obj.messageRelay.url,
                apiKey: obj.messageRelay.apiKey,
            }
            : undefined,
        heartbeatIntervalMs: typeof obj.heartbeatIntervalMs === "number"
            ? obj.heartbeatIntervalMs
            : DEFAULTS.heartbeatIntervalMs,
        offlineThresholdMs: typeof obj.offlineThresholdMs === "number"
            ? obj.offlineThresholdMs
            : DEFAULTS.offlineThresholdMs,
        description: typeof obj.description === "string" ? obj.description : undefined,
        supportsVision: typeof obj.supportsVision === "boolean" ? obj.supportsVision : undefined,
        localManager: obj.localManager
            ? {
                enabled: !!obj.localManager.enabled,
                hubUrl: obj.localManager.hubUrl,
                managerPass: obj.localManager.managerPass,
            }
            : undefined,
    };
}
/**
 * Returns a stable machine identifier.
 * Persists a UUID to ~/.openclaw/.machine-id on first call so the ID
 * survives hostname changes (common on macOS where hostname ≠ LocalHostName).
 * Falls back to hostname() if the file cannot be written.
 */
export function getMachineId() {
    const dir = join(homedir(), ".openclaw");
    const idFile = join(dir, ".machine-id");
    try {
        const existing = readFileSync(idFile, "utf-8").trim();
        if (existing)
            return existing;
    }
    catch {
        // File doesn't exist yet — generate one
    }
    // Use hostname as the base for readability, but append a short UUID suffix
    // so renames don't change the identity
    const id = `${hostname()}-${randomUUID().slice(0, 8)}`;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(idFile, id, "utf-8");
    }
    catch {
        // Can't persist — fall back to hostname
        return hostname();
    }
    return id;
}
