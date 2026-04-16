import type { ProjectData, ProjectIndex, TaskData, AssetData, TaskStatus, BlockType, PluginLogger } from "./types.js";
export declare class ProjectManager {
    private baseDir;
    private logger;
    private readonly readOnly;
    constructor(workspacePath: string, logger: PluginLogger, opts?: {
        readOnly?: boolean;
    });
    isReadOnly(): boolean;
    private indexPath;
    private readIndex;
    private writeIndex;
    getProjectDir(projectId: string): string;
    private projectJsonPath;
    createProject(name: string, description: string): ProjectData;
    readProject(projectId: string): ProjectData | null;
    writeProject(project: ProjectData): void;
    listProjects(): ProjectIndex;
    addTask(projectId: string, agent: string, title: string, brief: string, dependencies?: string[]): TaskData | null;
    updateTaskStatus(projectId: string, taskId: string, status: TaskStatus, extra?: {
        blockType?: BlockType;
        blockReason?: string;
        subThreadId?: string;
        outputs?: string[];
    }): TaskData | null;
    incrementRounds(projectId: string, taskId: string): {
        task: TaskData;
        softLimit: boolean;
        hardLimit: boolean;
    } | null;
    getReadyTasks(projectId: string): TaskData[];
    publishAsset(projectId: string, sourcePath: string, assetType: string, description: string, producer: string, taskId: string): AssetData | null;
    listAssets(projectId: string, typeFilter?: string, agentFilter?: string): AssetData[];
}
