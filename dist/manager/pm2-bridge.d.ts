export interface PM2Process {
    name: string;
    agentId: string;
    pid: number;
    status: string;
    memory: number;
    cpu: number;
    restarts: number;
    uptime: number;
}
export declare function listProcesses(): Promise<PM2Process[]>;
export declare function getProcessLogs(name: string): Promise<string>;
export declare function restartProcess(name: string): Promise<void>;
export declare function stopProcess(name: string): Promise<void>;
export declare function startProcess(name: string): Promise<void>;
export declare function stopAll(): Promise<void>;
export declare function startAll(ecosystemPath: string): Promise<void>;
