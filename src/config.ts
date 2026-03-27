import { hostname } from "node:os";
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
    heartbeatIntervalMs:
      typeof obj.heartbeatIntervalMs === "number"
        ? obj.heartbeatIntervalMs
        : DEFAULTS.heartbeatIntervalMs,
    offlineThresholdMs:
      typeof obj.offlineThresholdMs === "number"
        ? obj.offlineThresholdMs
        : DEFAULTS.offlineThresholdMs,
  };
}

export function getMachineId(): string {
  return hostname();
}
