import type { BridgeConfig, RegistryEntry, PluginLogger } from "./types.js";
export declare class BridgeFileOps {
    private config;
    private machineId;
    private workspacePath;
    private logger;
    constructor(config: BridgeConfig, machineId: string, workspacePath: string, logger: PluginLogger);
    private isSameMachine;
    private validatePathWithinWorkspace;
    private fileRelayHeaders;
    private fileRelayUrl;
    sendFile(target: RegistryEntry, localRelativePath: string): Promise<{
        delivered: boolean;
        message: string;
        filename?: string;
        renamed?: boolean;
    }>;
    readRemoteFile(target: RegistryEntry, relativePath: string): Promise<string>;
    writeRemoteFile(target: RegistryEntry, relativePath: string, content: string): Promise<void>;
    processPendingFiles(): Promise<number>;
    processPendingCommands(): Promise<number>;
}
