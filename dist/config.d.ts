import type { BridgeConfig } from "./types.js";
export declare function parseConfig(raw: unknown): BridgeConfig;
/**
 * Returns a stable machine identifier.
 * Persists a UUID to ~/.openclaw/.machine-id on first call so the ID
 * survives hostname changes (common on macOS where hostname ≠ LocalHostName).
 * Falls back to hostname() if the file cannot be written.
 */
export declare function getMachineId(): string;
