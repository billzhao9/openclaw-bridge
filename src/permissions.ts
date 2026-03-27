import type { BridgeConfig } from "./types.js";

const PUBLIC_ACTIONS = new Set(["discover", "whois", "send_file"]);
const SUPERUSER_ACTIONS = new Set(["read_file", "write_file", "restart"]);

export function checkPermission(action: string, config: BridgeConfig): boolean {
  if (PUBLIC_ACTIONS.has(action)) return true;
  if (SUPERUSER_ACTIONS.has(action)) return config.role === "superuser";
  return false;
}

export function assertPermission(action: string, config: BridgeConfig): void {
  if (!checkPermission(action, config)) {
    throw new Error(
      `openclaw-bridge: permission denied — "${action}" requires superuser role, current role is "${config.role}"`,
    );
  }
}
