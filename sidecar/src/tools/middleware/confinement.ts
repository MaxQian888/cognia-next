// Confines every built-in tool call to the session's sandbox roots when the
// host sandboxes built-in processes: the call's paths are checked against the
// scope before the handler runs, and the handler then runs inside that scope
// so any process it spawns is launched confined.

import type { ToolDefinition, ToolHandlerExtra, WrappedToolDefinition } from "../kernel/define.ts"
import { toolError } from "../kernel/result.ts"
import { assertToolCallWithinRoots } from "../../policy/confinement/enforce.ts"
import { withProcessSandbox } from "../../platform/process/exec.ts"
import type { ProcessSandboxScope, ProcessPortContext } from "../../platform/process/exec.ts"

/**
 * Wrap handlers in their process policy and host port resolver. Standalone
 * definitions without either capability come back untouched.
 */
export function wrapDefsWithConfinement<D extends ToolDefinition>(
  defs: readonly D[],
  scope: ProcessSandboxScope | undefined,
  cwd: string | undefined,
  ports: ProcessPortContext = {}
): readonly WrappedToolDefinition<D>[] {
  if (!scope && !ports.hostRpc) return defs
  return defs.map((definition) => ({
    ...definition,
    handler: async (input: unknown, extra?: ToolHandlerExtra) => {
      try {
        if (scope) assertToolCallWithinRoots(scope, definition.name, input, cwd)
        return await withProcessSandbox(scope, cwd, () => definition.handler(input, extra), ports)
      } catch (error) {
        return toolError(error, definition.name)
      }
    },
  }))
}
