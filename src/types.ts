export interface MessageRelayConfig {
  url: string;       // ws://host:3080/ws
  apiKey: string;
}

export interface LocalManagerConfig {
  enabled: boolean;
  hubUrl: string;
  managerPass: string;
}

export interface BridgeConfig {
  role: "normal" | "superuser";
  agentId: string;
  agentName: string;
  registry: {
    provider?: string;
    baseUrl: string;
    apiKey?: string;
  };
  fileRelay?: {
    baseUrl: string;
    apiKey?: string;
  };
  messageRelay?: MessageRelayConfig;
  heartbeatIntervalMs?: number;
  offlineThresholdMs?: number;
  description?: string;
  supportsVision?: boolean;
  localManager?: LocalManagerConfig;
}

export interface ChannelInfo {
  type: string;       // "discord", "slack", "web", etc.
  channelId: string;  // platform-specific channel identifier
  name: string;       // human-readable name, e.g. "#creators", "DM-user1"
}

export interface RegistryEntry {
  type: "gateway-registry";
  agentId: string;
  agentName: string;
  machineId: string;
  host: string;
  port: number;
  workspacePath: string;
  discordId: string | null;
  discordConnected?: boolean;
  role: "normal" | "superuser";
  capabilities: string[];
  channels: ChannelInfo[];
  registeredAt: string;
  lastHeartbeat: string;
  status: "online" | "offline";
  memMB?: number;
  description?: string;
  supportsVision?: boolean;
}

export interface DiscoverResult {
  agents: RegistryEntry[];
}

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookAgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type OpenClawPluginApi = {
  pluginConfig?: unknown;
  logger: PluginLogger;
  registerTool: (
    tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    },
    opts?: { name?: string; names?: string[] },
  ) => void;
  registerService: (service: {
    id: string;
    start: (ctx?: unknown) => void | Promise<void>;
    stop?: (ctx?: unknown) => void | Promise<void>;
  }) => void;
  on: (
    hookName: string,
    handler: (event: unknown, ctx?: HookAgentContext) => unknown,
    opts?: { priority?: number },
  ) => void;
};
