import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface WorkerWorkspaceBinding {
  bindingRef: string
  sourceRoot: string
  gitCommonDir: string
  repositoryFingerprint: string
  createdAt: number
  updatedAt: number
}

interface WorkerWorkspaceClientOptions {
  dataDir: string
  helperPath?: string
  spawn?: (
    command: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "pipe"] }
  ) => ChildProcessWithoutNullStreams
}

export interface WorkerWorkspaceClient {
  bind(repositoryRef: string, sourcePath: string): Promise<WorkerWorkspaceBinding>
  list(): Promise<WorkerWorkspaceBinding[]>
  remove(repositoryRef: string): Promise<{ removed: boolean }>
  resolve(repositoryRef: string): Promise<WorkerWorkspaceBinding>
  begin(repositoryRef: string, request: unknown): Promise<Record<string, unknown>>
}

export function createWorkerWorkspaceClient(
  options: WorkerWorkspaceClientOptions
): WorkerWorkspaceClient {
  const spawn = options.spawn ?? nodeSpawn
  const helperPath =
    options.helperPath ??
    resolveWorkerWorkspaceHelper(process.env, import.meta.url, process.execPath)

  function call<T>(command: string, args: string[], input = ""): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(helperPath, [command, "--data-dir", options.dataDir, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => (stdout += chunk))
      child.stderr.on("data", (chunk: string) => (stderr += chunk))
      child.once("error", reject)
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Task Workspace helper exited with code ${code}`))
          return
        }
        try {
          resolve(JSON.parse(stdout) as T)
        } catch (error) {
          reject(new Error(`invalid Task Workspace helper response: ${(error as Error).message}`))
        }
      })
      child.stdin.end(input)
    })
  }

  return {
    bind(repositoryRef, sourcePath) {
      return call("bind", ["--repository-ref", repositoryRef, "--path", sourcePath])
    },
    list() {
      return call("list", [])
    },
    remove(repositoryRef) {
      return call("remove", ["--repository-ref", repositoryRef])
    },
    resolve(repositoryRef) {
      return call("resolve", ["--repository-ref", repositoryRef])
    },
    begin(repositoryRef, request) {
      return call("begin", ["--repository-ref", repositoryRef], JSON.stringify(request))
    },
  }
}

export function resolveWorkerWorkspaceHelper(
  env: Record<string, string | undefined>,
  moduleUrl: string,
  executablePath: string
): string {
  const override = env.COGNIA_TASK_WORKSPACE_HELPER?.trim()
  if (override) return override
  const executable =
    process.platform === "win32"
      ? "cognia-task-workspace-worker.exe"
      : "cognia-task-workspace-worker"
  const moduleDir = path.dirname(fileURLToPath(moduleUrl))
  const candidates = [
    path.join(moduleDir, executable),
    path.join(moduleDir, "..", executable),
    path.join(path.dirname(executablePath), executable),
    path.join(process.cwd(), "cli", "dist", executable),
    path.join(process.cwd(), "target", "release", executable),
    path.join(process.cwd(), "target", "debug", executable),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}
