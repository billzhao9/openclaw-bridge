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
  isProjectManager?: boolean;
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

// ── Project Management Types ─────────────────────────────────────────

export interface AssetData {
  id: string;
  path: string;
  type: string;
  producer: string;
  taskId: string;
  description: string;
  publishedAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type BlockType = "capability_missing" | "dependency_failed" | "clarification_needed";

export interface TaskData {
  id: string;
  agent: string;
  title: string;
  brief: string;
  status: TaskStatus;
  subThreadId: string | null;
  dependencies: string[];
  rounds: number;
  maxRounds: number;
  outputs: string[];
  blockType: BlockType | null;
  blockReason: string | null;
  reworkCount: number;
  assignedAt: string;
  completedAt: string | null;
}

export type ProjectStatus = "in_progress" | "waiting_clarification" | "completed" | "paused" | "cancelled";

export interface ProjectData {
  id: string;
  name: string;
  description: string;
  threadId: string | null;
  status: ProjectStatus;
  createdAt: string;
  tasks: TaskData[];
  assets: AssetData[];
  totalRounds: number;
}

export interface ProjectIndex {
  activeProjects: Array<{
    id: string;
    status: ProjectStatus;
    threadId: string | null;
  }>;
}
