import type { BridgeConfig } from "./types.js";
export declare function checkPermission(action: string, config: BridgeConfig): boolean;
export declare function assertPermission(action: string, config: BridgeConfig): void;
