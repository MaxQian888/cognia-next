import os from "node:os"
import path from "node:path"

import { createWorkerWorkspaceClient, type WorkerWorkspaceClient } from "../worker/workspace-client"
import { resolveHome } from "../config/load"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface WorkerCommandDeps {
  out?: OutputSink
  workspace?: WorkerWorkspaceClient
  env?: Record<string, string | undefined>
  homedir?: string
}

export async function workerCommand(
  args: ParsedArgs,
  deps: WorkerCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const workspace =
    deps.workspace ??
    createWorkerWorkspaceClient({
      dataDir:
        env.COGNIA_DATA_DIR?.trim() ||
        path.join(resolveHome(env, deps.homedir ?? os.homedir()), "worker-data"),
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
      default:
        out.error("Usage: cognia-agent worker <bind|list|remove>\n")
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
