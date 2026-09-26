// Confines every built-in tool call to the session's sandbox roots when the
// host sandboxes built-in processes: the call's paths are checked against the
// scope before the handler runs, and the handler then runs inside that scope
// so any process it spawns is launched confined.

import type { ToolDefinition, ToolHandlerExtra, WrappedToolDefinition } from "../kernel/define.ts"
import { toolError } from "../kernel/result.ts"
import { assertToolCallWithinRoots } from "../../policy/confinement/enforce.ts"
import { withProcessSandbox } from "../../platform/process/exec.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"

/**
 * Wrap each definition's handler in the sandbox scope. Without a scope the
 * definitions come back untouched.
 */
export function wrapDefsWithConfinement<D extends ToolDefinition>(
  defs: readonly D[],
  scope: ProcessSandboxScope | undefined,
  cwd: string | undefined
): readonly WrappedToolDefinition<D>[] {
  if (!scope) return defs
  return defs.map((definition) => ({
    ...definition,
    handler: async (input: unknown, extra?: ToolHandlerExtra) => {
      try {
        assertToolCallWithinRoots(scope, definition.name, input, cwd)
      } catch (error) {
        return toolError(error, definition.name)
      }
      return withProcessSandbox(scope, cwd, () => definition.handler(input, extra))
    },
  }))
}
