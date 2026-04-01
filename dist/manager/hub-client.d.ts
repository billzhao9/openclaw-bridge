import type { PluginLogger } from "../types.js";
export declare class ManagerHubClient {
    private hubUrl;
    private apiKey;
    private managerPass;
    private machineId;
    private ws;
    private _connected;
    private reconnectDelay;
    private logger;
    onCommand: ((msg: any) => void) | null;
    constructor(hubUrl: string, apiKey: string, managerPass: string, logger: PluginLogger);
    get connected(): boolean;
    connect(): Promise<void>;
    sendStatus(agents: any[], logs?: Record<string, string>): void;
    sendResult(action: string, target: string, success: boolean): void;
    disconnect(): void;
}
