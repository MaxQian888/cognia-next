import os from "node:os"
import path from "node:path"

import { createWorkerWorkspaceClient, type WorkerWorkspaceClient } from "../worker/workspace-client"
import { connectWorker, enrollWorker } from "../worker/worker-connect"
import { loadConfig, resolveHome } from "../config/load"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface WorkerCommandDeps {
  out?: OutputSink
  workspace?: WorkerWorkspaceClient
  env?: Record<string, string | undefined>
  homedir?: string
  connect?: typeof connectWorker
  enroll?: typeof enrollWorker
  loadConfig?: typeof loadConfig
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
        const requestedMax = Number(stringFlag(args, "max-active-turns") ?? "1")
        if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 32) {
          throw new Error("--max-active-turns must be an integer between 1 and 32")
        }
        await (deps.connect ?? connectWorker)({
          deviceConfigPath: stringFlag(args, "config") ?? path.join(home, "worker-device.json"),
          runtimeConfig: (deps.loadConfig ?? loadConfig)(),
          home,
          workspace,
          maxActiveTurns: requestedMax,
        })
        return 0
      }
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
        out.error("Usage: cognia-agent worker <enroll|bind|list|remove|connect>\n")
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

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}
