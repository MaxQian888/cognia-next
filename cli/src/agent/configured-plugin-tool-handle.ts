/** CLI plugin-tool handle bound to one resolved config snapshot. */

import type {
  PluginToolExecHostDeps,
  PluginToolExecRequest,
  PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"

import { buildCliWebToolDeps } from "../config/web-tool-deps"
import type { ResolvedConfig } from "../config/schema"
import { makeCliPluginToolHandle } from "./subagent-dispatch"

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
  return makeCliPluginToolHandle((request) =>
    execute(request, {
      resolveWebToolDeps: () => buildCliWebToolDeps(config),
    })
  )
}
