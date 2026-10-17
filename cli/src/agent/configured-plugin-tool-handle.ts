/** CLI plugin-tool handle bound to one resolved config snapshot. */

import type {
  PluginToolExecHostDeps,
  PluginToolExecRequest,
  PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"

import os from "node:os"

import { buildCliWebToolDeps } from "../config/web-tool-deps"
import { resolveHome } from "../config/load"
import type { ResolvedConfig } from "../config/schema"
import { makeCliPluginToolHandle } from "./subagent-dispatch"
import { createFileWorkingSetStore } from "./working-set-file-store"

type PluginToolExecutor = (
  request: PluginToolExecRequest,
  hostDeps?: PluginToolExecHostDeps
) => Promise<PluginToolExecResponse>

const defaultExecutor: PluginToolExecutor = async (request, hostDeps) => {
  const { handlePluginToolExec } = await import("@/lib/claude/plugin-tool-ipc")
  return handlePluginToolExec(request, hostDeps)
}

/**
 * Bind the promoted web tools to CLI files/env without renderer state.
 *
 * There is no per-plugin wiring here any more. A plugin that needs the CLI's
 * model or web policy gets it from the session's host runtime
 * (`bindCliSessionHostRuntime`), which every session registers for itself —
 * so one plugin can no longer be the only one the CLI knows how to serve.
 */
export function makeConfiguredCliPluginToolHandle(
  config: ResolvedConfig,
  execute: PluginToolExecutor = defaultExecutor
): (request: PluginToolExecRequest) => Promise<PluginToolExecResponse> {
  // CLI sessions are not Dexie rows, so `working_set` keeps its state in a
  // per-session file under the CLI home instead of the desktop session row.
  const workingSetStore = createFileWorkingSetStore({
    home: config.cliHome ?? resolveHome(process.env, os.homedir()),
  })
  return makeCliPluginToolHandle((request) =>
    execute(request, {
      workingSetStore,
      resolveWebToolDeps: () => buildCliWebToolDeps(config),
      resolveAttachmentToolDeps: async () => {
        const { ensureCliDb } = await import("../db/bootstrap")
        await ensureCliDb()
        const { resolveAttachmentToolDeps } = await import("@/lib/claude/attachment-builtin-tools")
        return resolveAttachmentToolDeps()
      },
    })
  )
}
