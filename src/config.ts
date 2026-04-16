import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./types.js";

const DEFAULTS = {
  heartbeatIntervalMs: 30_000,
  offlineThresholdMs: 120_000,
} as const;

export function parseConfig(raw: unknown): BridgeConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("openclaw-bridge: missing plugin config");
  }
  const obj = raw as Record<string, unknown>;

  if (!obj.role || (obj.role !== "normal" && obj.role !== "superuser")) {
    throw new Error('openclaw-bridge: config.role must be "normal" or "superuser"');
  }
  if (!obj.agentId || typeof obj.agentId !== "string") {
    throw new Error("openclaw-bridge: config.agentId is required");
  }
  if (!obj.agentName || typeof obj.agentName !== "string") {
    throw new Error("openclaw-bridge: config.agentName is required");
  }
  const registry = obj.registry as Record<string, unknown> | undefined;
  if (!registry || !registry.baseUrl || typeof registry.baseUrl !== "string") {
    throw new Error("openclaw-bridge: config.registry.baseUrl is required");
  }

  return {
    role: obj.role as "normal" | "superuser",
    isProjectManager: obj.isProjectManager === true,
    agentId: obj.agentId as string,
    agentName: obj.agentName as string,
    registry: {
      provider: (registry.provider as string) ?? "openviking",
      baseUrl: registry.baseUrl as string,
      apiKey: registry.apiKey as string | undefined,
    },
    fileRelay: obj.fileRelay
      ? {
          baseUrl: (obj.fileRelay as Record<string, unknown>).baseUrl as string,
          apiKey: (obj.fileRelay as Record<string, unknown>).apiKey as string | undefined,
        }
      : undefined,
    messageRelay: obj.messageRelay
      ? {
          url: (obj.messageRelay as Record<string, unknown>).url as string,
          apiKey: (obj.messageRelay as Record<string, unknown>).apiKey as string,
        }
      : undefined,
    heartbeatIntervalMs:
      typeof obj.heartbeatIntervalMs === "number"
        ? obj.heartbeatIntervalMs
        : DEFAULTS.heartbeatIntervalMs,
    offlineThresholdMs:
      typeof obj.offlineThresholdMs === "number"
        ? obj.offlineThresholdMs
        : DEFAULTS.offlineThresholdMs,
    description: typeof obj.description === "string" ? obj.description : undefined,
    supportsVision: typeof obj.supportsVision === "boolean" ? obj.supportsVision : undefined,
    localManager: obj.localManager
      ? {
          enabled: !!(obj.localManager as Record<string, unknown>).enabled,
          hubUrl: (obj.localManager as Record<string, unknown>).hubUrl as string,
          managerPass: (obj.localManager as Record<string, unknown>).managerPass as string,
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
export function getMachineId(): string {
  const dir = join(homedir(), ".openclaw");
  const idFile = join(dir, ".machine-id");
  try {
    const existing = readFileSync(idFile, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet — generate one
  }
  // Use hostname as the base for readability, but append a short UUID suffix
  // so renames don't change the identity
  const id = `${hostname()}-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(idFile, id, "utf-8");
  } catch {
    // Can't persist — fall back to hostname
    return hostname();
  }
  return id;
}
