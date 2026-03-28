import { exec } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const _exec = promisify(exec);
const execAsync = async (cmd: string, opts?: Record<string, unknown>) => {
  const result = await _exec(cmd, { windowsHide: true, encoding: "utf-8", ...opts } as any);
  return { stdout: result.stdout as unknown as string, stderr: result.stderr as unknown as string };
};
const IS_WIN = platform() === "win32";

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

async function killPort(port: number): Promise<void> {
  if (!port) return;
  try {
    if (IS_WIN) {
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
      );
      const pids = new Set<string>();
      stdout.split("\n").forEach((line: string) => {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      });
      for (const pid of pids) {
        await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
      }
    } else {
      await execAsync(`lsof -ti:${port} | xargs kill -9`).catch(() => {});
    }
  } catch {
    // No process on port
  }
}

async function getProcessPort(name: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const apps = JSON.parse(stdout);
    const app = apps.find((a: any) => a.name === name);
    if (app?.pm2_env?.env?.OPENCLAW_GATEWAY_PORT) {
      return parseInt(app.pm2_env.env.OPENCLAW_GATEWAY_PORT, 10);
    }
    if (app?.pm2_env?.pm_exec_path) {
      const { readFileSync } = await import("node:fs");
      const dir = app.pm2_env.pm_exec_path.replace(/[/\\]run\.sh$/, "");
      const script = readFileSync(dir + "/run.sh", "utf-8");
      const match = script.match(/OPENCLAW_GATEWAY_PORT="?(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  } catch {}
  return null;
}

export async function listProcesses(): Promise<PM2Process[]> {
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const apps = JSON.parse(stdout);
    return apps.map((p: any) => ({
      name: p.name,
      agentId: p.name.replace(/^gw-/, ""),
      pid: p.pid,
      status: p.pm2_env?.status || "unknown",
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      restarts: p.pm2_env?.restart_time || 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
  } catch (err: any) {
    return [];
  }
}

export async function getProcessLogs(name: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `pm2 logs ${name} --nostream --lines 100`,
      { timeout: 10_000 },
    );
    return stdout;
  } catch {
    return "(logs unavailable)";
  }
}

export async function restartProcess(name: string): Promise<void> {
  await execAsync("pm2 stop " + name).catch(() => {});
  const port = await getProcessPort(name);
  if (port) await killPort(port);
  await new Promise((r) => setTimeout(r, 1000));
  await execAsync("pm2 restart " + name);
}

export async function stopProcess(name: string): Promise<void> {
  await execAsync("pm2 stop " + name);
  const port = await getProcessPort(name);
  if (port) await killPort(port);
}

export async function startProcess(name: string): Promise<void> {
  const port = await getProcessPort(name);
  if (port) await killPort(port);
  await execAsync("pm2 restart " + name);
}

export async function stopAll(): Promise<void> {
  const procs = await listProcesses();
  await execAsync("pm2 stop all");
  for (const proc of procs) {
    const port = await getProcessPort(proc.name);
    if (port) await killPort(port);
  }
}

export async function startAll(ecosystemPath: string): Promise<void> {
  await execAsync("pm2 start " + ecosystemPath);
}
