import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type {
  ProjectData,
  ProjectIndex,
  TaskData,
  AssetData,
  TaskStatus,
  BlockType,
  ProjectStatus,
  PluginLogger,
} from "./types.js";

const SOFT_ROUND_LIMIT = 8;
const HARD_ROUND_LIMIT = 15;

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function generateId(prefix: string): string {
  // UUID v4 without dashes, first 10 chars — enough entropy to avoid collisions
  const uuid = randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}-${uuid}`;
}

export class ProjectManager {
  private baseDir: string;
  private logger: PluginLogger;
  private readonly readOnly: boolean;

  constructor(workspacePath: string, logger: PluginLogger, opts: { readOnly?: boolean } = {}) {
    this.baseDir = join(workspacePath || join(homedir(), ".openclaw"), "_projects");
    this.logger = logger;
    this.readOnly = opts.readOnly === true;
    if (!this.readOnly) {
      mkdirSync(this.baseDir, { recursive: true });
      this.logger.info(`[ProjectManager] base dir: ${this.baseDir}`);
    } else {
      this.logger.info(`[ProjectManager] running in read-only mode (non-PM agent)`);
    }
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  // ── Index helpers ────────────────────────────────────────────────────

  private indexPath(): string {
    return join(this.baseDir, "index.json");
  }

  private readIndex(): ProjectIndex {
    const p = this.indexPath();
    if (!existsSync(p)) {
      return { activeProjects: [] };
    }
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as ProjectIndex;
    } catch (err) {
      this.logger.warn(`[ProjectManager] failed to parse index.json: ${err}`);
      return { activeProjects: [] };
    }
  }

  private writeIndex(index: ProjectIndex): void {
    writeFileSync(this.indexPath(), JSON.stringify(index, null, 2), "utf-8");
  }

  // ── Directory helpers ────────────────────────────────────────────────

  getProjectDir(projectId: string): string {
    return join(this.baseDir, projectId);
  }

  private projectJsonPath(projectId: string): string {
    return join(this.getProjectDir(projectId), "project.json");
  }

  // ── Project CRUD ─────────────────────────────────────────────────────

  createProject(name: string, description: string): ProjectData {
    if (this.readOnly) {
      throw new Error("ProjectManager is read-only on this agent — only the PM can create projects");
    }
    const slug = slugify(name);
    // Always append a UUID suffix so same-name projects within one ms never collide
    const uniq = randomUUID().replace(/-/g, "").slice(0, 10);
    const id = slug ? `${slug}-${uniq}` : generateId("proj");

    const dir = this.getProjectDir(id);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, "briefs"), { recursive: true });

    const project: ProjectData = {
      id,
      name,
      description,
      threadId: null,
      status: "in_progress",
      createdAt: nowIso(),
      tasks: [],
      assets: [],
      totalRounds: 0,
    };

    writeFileSync(this.projectJsonPath(id), JSON.stringify(project, null, 2), "utf-8");

    const index = this.readIndex();
    index.activeProjects.push({ id, status: project.status, threadId: null });
    this.writeIndex(index);

    this.logger.info(`[ProjectManager] created project "${name}" → ${id}`);
    return project;
  }

  readProject(projectId: string): ProjectData | null {
    const p = this.projectJsonPath(projectId);
    if (!existsSync(p)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as ProjectData;
    } catch (err) {
      this.logger.error(`[ProjectManager] failed to read project ${projectId}: ${err}`);
      return null;
    }
  }

  writeProject(project: ProjectData): void {
    if (this.readOnly) {
      this.logger.warn(`[ProjectManager] writeProject ignored (read-only): ${project.id}`);
      return;
    }
    const dir = this.getProjectDir(project.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.projectJsonPath(project.id), JSON.stringify(project, null, 2), "utf-8");

    // Sync index entry
    const index = this.readIndex();
    const entry = index.activeProjects.find((e) => e.id === project.id);
    if (entry) {
      entry.status = project.status;
      entry.threadId = project.threadId;
    } else {
      index.activeProjects.push({
        id: project.id,
        status: project.status,
        threadId: project.threadId,
      });
    }
    this.writeIndex(index);
  }

  listProjects(): ProjectIndex {
    return this.readIndex();
  }

  // ── Task lifecycle ────────────────────────────────────────────────────

  addTask(
    projectId: string,
    agent: string,
    title: string,
    brief: string,
    dependencies: string[] = [],
  ): TaskData | null {
    const project = this.readProject(projectId);
    if (!project) {
      this.logger.warn(`[ProjectManager] addTask: project not found: ${projectId}`);
      return null;
    }

    const task: TaskData = {
      id: generateId("task"),
      agent,
      title,
      brief,
      status: "pending",
      subThreadId: null,
      dependencies,
      rounds: 0,
      maxRounds: HARD_ROUND_LIMIT,
      outputs: [],
      blockType: null,
      blockReason: null,
      reworkCount: 0,
      assignedAt: nowIso(),
      completedAt: null,
    };

    project.tasks.push(task);
    this.writeProject(project);
    this.logger.info(`[ProjectManager] added task "${title}" (${task.id}) to project ${projectId}`);
    return task;
  }

  updateTaskStatus(
    projectId: string,
    taskId: string,
    status: TaskStatus,
    extra?: {
      blockType?: BlockType;
      blockReason?: string;
      subThreadId?: string;
      outputs?: string[];
    },
  ): TaskData | null {
    const project = this.readProject(projectId);
    if (!project) {
      this.logger.warn(`[ProjectManager] updateTaskStatus: project not found: ${projectId}`);
      return null;
    }

    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.logger.warn(`[ProjectManager] updateTaskStatus: task not found: ${taskId}`);
      return null;
    }

    task.status = status;

    if (status === "completed") {
      task.completedAt = nowIso();
      task.blockType = null;
      task.blockReason = null;
    }

    if (extra) {
      if (extra.blockType !== undefined) task.blockType = extra.blockType;
      if (extra.blockReason !== undefined) task.blockReason = extra.blockReason;
      if (extra.subThreadId !== undefined) task.subThreadId = extra.subThreadId;
      if (extra.outputs !== undefined) task.outputs = extra.outputs;
    }

    this.writeProject(project);
    this.logger.info(`[ProjectManager] task ${taskId} status → ${status}`);
    return task;
  }

  incrementRounds(
    projectId: string,
    taskId: string,
  ): { task: TaskData; softLimit: boolean; hardLimit: boolean } | null {
    const project = this.readProject(projectId);
    if (!project) {
      this.logger.warn(`[ProjectManager] incrementRounds: project not found: ${projectId}`);
      return null;
    }

    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.logger.warn(`[ProjectManager] incrementRounds: task not found: ${taskId}`);
      return null;
    }

    task.rounds += 1;
    project.totalRounds += 1;

    const softLimit = task.rounds >= SOFT_ROUND_LIMIT;
    const hardLimit = task.rounds >= HARD_ROUND_LIMIT;

    this.writeProject(project);

    if (hardLimit) {
      this.logger.warn(
        `[ProjectManager] task ${taskId} hit HARD round limit (${task.rounds}/${HARD_ROUND_LIMIT})`,
      );
    } else if (softLimit) {
      this.logger.warn(
        `[ProjectManager] task ${taskId} hit soft round limit (${task.rounds}/${SOFT_ROUND_LIMIT})`,
      );
    }

    return { task, softLimit, hardLimit };
  }

  getReadyTasks(projectId: string): TaskData[] {
    const project = this.readProject(projectId);
    if (!project) {
      return [];
    }

    const completedIds = new Set(
      project.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );

    return project.tasks.filter(
      (t) =>
        t.status === "pending" &&
        t.dependencies.every((depId) => completedIds.has(depId)),
    );
  }

  // ── Asset registry ────────────────────────────────────────────────────

  publishAsset(
    projectId: string,
    sourcePath: string,
    assetType: string,
    description: string,
    producer: string,
    taskId: string,
  ): AssetData | null {
    const project = this.readProject(projectId);
    if (!project) {
      this.logger.warn(`[ProjectManager] publishAsset: project not found: ${projectId}`);
      return null;
    }

    const assetsDir = join(this.getProjectDir(projectId), "assets");
    mkdirSync(assetsDir, { recursive: true });

    const assetId = generateId("asset");
    const destFilename = `${assetId}-${basename(sourcePath)}`;
    const destPath = join(assetsDir, destFilename);

    try {
      copyFileSync(sourcePath, destPath);
    } catch (err) {
      this.logger.error(`[ProjectManager] failed to copy asset from ${sourcePath}: ${err}`);
      return null;
    }

    const asset: AssetData = {
      id: assetId,
      path: destPath,
      type: assetType,
      producer,
      taskId,
      description,
      publishedAt: nowIso(),
    };

    project.assets.push(asset);
    this.writeProject(project);

    this.logger.info(
      `[ProjectManager] published asset ${assetId} (${assetType}) for project ${projectId}`,
    );
    return asset;
  }

  listAssets(
    projectId: string,
    typeFilter?: string,
    agentFilter?: string,
  ): AssetData[] {
    const project = this.readProject(projectId);
    if (!project) {
      return [];
    }

    let assets = project.assets;

    if (typeFilter) {
      assets = assets.filter((a) => a.type === typeFilter);
    }

    if (agentFilter) {
      assets = assets.filter((a) => a.producer === agentFilter);
    }

    return assets;
  }
}
