import os from "node:os"
import path from "node:path"

import { createWorkerWorkspaceClient, type WorkerWorkspaceClient } from "../worker/workspace-client"
import { connectWorker, enrollWorker } from "../worker/worker-connect"
import {
  collectWorkerDaemonGarbage,
  readWorkerDaemonLog,
  startWorkerDaemon,
  stopWorkerDaemon,
  workerDaemonStatus,
} from "../worker/daemon"
import { installWorkerService, uninstallWorkerService } from "../worker/daemon-service"
import { loadConfig, resolveHome } from "../config/load"
import { VERSION } from "../version"
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/** How long a rotated log or an abandoned task workspace survives a GC pass. */
const DAEMON_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface WorkerCommandDeps {
  out?: OutputSink
  workspace?: WorkerWorkspaceClient
  env?: Record<string, string | undefined>
  homedir?: string
  connect?: typeof connectWorker
  enroll?: typeof enrollWorker
  loadConfig?: typeof loadConfig
  daemon?: {
    start?: typeof startWorkerDaemon
    stop?: typeof stopWorkerDaemon
    status?: typeof workerDaemonStatus
    logs?: typeof readWorkerDaemonLog
    gc?: typeof collectWorkerDaemonGarbage
  }
  service?: {
    install?: typeof installWorkerService
    uninstall?: typeof uninstallWorkerService
  }
  execPath?: string
  scriptPath?: string
}

export async function workerCommand(
  args: ParsedArgs,
  deps: WorkerCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = resolveHome(env, deps.homedir ?? os.homedir())
  const workspace =
    deps.workspace ??
    createWorkerWorkspaceClient({
      dataDir: env.COGNIA_DATA_DIR?.trim() || path.join(home, "worker-data"),
    })
  try {
    let result: unknown
    switch (args.subcommand) {
      case "bind": {
        const repositoryRef = requiredFlag(args, "repository-ref")
        const sourcePath = requiredFlag(args, "path")
        result = await workspace.bind(repositoryRef, sourcePath)
        break
      }
      case "list":
        result = await workspace.list()
        break
      case "remove":
        result = await workspace.remove(requiredFlag(args, "repository-ref"))
        break
      case "connect": {
        await (deps.connect ?? connectWorker)(connectOptions(args, deps, home, workspace))
        return 0
      }
      case "daemon":
        return await daemonSubcommand(args, deps, out, home, workspace)
      case "service":
        return serviceSubcommand(args, deps, out)
      case "enroll": {
        const deviceConfigPath = stringFlag(args, "config") ?? path.join(home, "worker-device.json")
        const enrolled = await (deps.enroll ?? enrollWorker)({
          baseUrl: requiredFlag(args, "server-url"),
          tenantId: requiredFlag(args, "tenant-id"),
          enrollment: requiredFlag(args, "enrollment"),
          displayName: stringFlag(args, "name") ?? os.hostname(),
          deviceConfigPath,
          ...(stringFlag(args, "fingerprint")
            ? { serverFingerprint: stringFlag(args, "fingerprint") }
            : {}),
        })
        result = { deviceId: enrolled.deviceId, configPath: deviceConfigPath }
        break
      }
      default:
        out.error(
          "Usage: cognia-agent worker <enroll|bind|list|remove|connect|daemon|service>\n" +
            "  daemon  start [--foreground] | stop | status | logs [-n N] | gc  [--profile <name>]\n" +
            "  service install | uninstall  [--profile <name>]\n"
        )
        return 2
    }
    if (boolFlag(args, "json")) out.json(result)
    else out.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    out.error(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function connectOptions(
  args: ParsedArgs,
  deps: WorkerCommandDeps,
  home: string,
  workspace: WorkerWorkspaceClient
) {
  const requestedMax = Number(stringFlag(args, "max-active-turns") ?? "1")
  if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 32) {
    throw new Error("--max-active-turns must be an integer between 1 and 32")
  }
  return {
    deviceConfigPath: stringFlag(args, "config") ?? path.join(home, "worker-device.json"),
    runtimeConfig: (deps.loadConfig ?? loadConfig)(),
    home,
    workspace,
    maxActiveTurns: requestedMax,
  }
}

async function daemonSubcommand(
  args: ParsedArgs,
  deps: WorkerCommandDeps,
  out: OutputSink,
  home: string,
  workspace: WorkerWorkspaceClient
): Promise<number> {
  const profile = stringFlag(args, "profile")
  const action = args.positionals[0]
  const emit = (value: unknown) => {
    if (boolFlag(args, "json")) out.json(value)
    else out.write(`${JSON.stringify(value, null, 2)}\n`)
  }

  switch (action) {
    case "start": {
      const foreground = boolFlag(args, "foreground")
      const result = await (deps.daemon?.start ?? startWorkerDaemon)(
        {
          home,
          ...(profile ? { profile } : {}),
          foreground,
          connectOptions: connectOptions(args, deps, home, workspace),
          ...(foreground ? { signal: shutdownSignal() } : {}),
        },
        {
          version: VERSION,
          ...(deps.execPath ? { execPath: deps.execPath } : {}),
          ...(deps.scriptPath ? { scriptPath: deps.scriptPath } : {}),
        }
      )
      if (result.alreadyRunning) {
        out.error(`worker daemon is already running (pid ${result.pid})\n`)
        return 1
      }
      if (!foreground) emit(result)
      return 0
    }
    case "stop": {
      const result = await (deps.daemon?.stop ?? stopWorkerDaemon)(home, profile)
      emit(result)
      return result.stopped ? 0 : 1
    }
    case "status": {
      const status = (deps.daemon?.status ?? workerDaemonStatus)(home, profile)
      emit(status)
      return status.running ? 0 : 1
    }
    case "logs": {
      const lines = numberFlag(args, "n") ?? 200
      const result = (deps.daemon?.logs ?? readWorkerDaemonLog)(home, profile, lines)
      if (boolFlag(args, "json")) out.json(result)
      else out.write(result.lines.length ? `${result.lines.join("\n")}\n` : "")
      return 0
    }
    case "gc": {
      const result = (deps.daemon?.gc ?? collectWorkerDaemonGarbage)(home, profile, {
        workspaceRoot: path.join(home, "worker-data", "workspaces"),
        ttlMs: DAEMON_GC_TTL_MS,
      })
      emit(result)
      return 0
    }
    default:
      out.error("Usage: cognia-agent worker daemon <start|stop|status|logs|gc>\n")
      return 2
  }
}

function serviceSubcommand(args: ParsedArgs, deps: WorkerCommandDeps, out: OutputSink): number {
  const action = args.positionals[0]
  const request = {
    execPath: deps.execPath ?? process.execPath,
    scriptPath: deps.scriptPath ?? process.argv[1] ?? "",
    profile: stringFlag(args, "profile") ?? "default",
  }
  const emit = (value: unknown) => {
    if (boolFlag(args, "json")) out.json(value)
    else out.write(`${JSON.stringify(value, null, 2)}\n`)
  }
  switch (action) {
    case "install":
      emit((deps.service?.install ?? installWorkerService)(request))
      return 0
    case "uninstall":
      emit((deps.service?.uninstall ?? uninstallWorkerService)(request))
      return 0
    default:
      out.error("Usage: cognia-agent worker service <install|uninstall>\n")
      return 2
  }
}

/**
 * Abort the connection loop on SIGINT/SIGTERM so a foreground daemon unwinds
 * the same way `serve` does, rather than being killed mid-turn by the OS.
 */
function shutdownSignal(): AbortSignal {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return controller.signal
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}
