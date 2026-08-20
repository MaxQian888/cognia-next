/**
 * Which Pro IDE should a caller that does not *host* one drive?
 *
 * Workflow nodes, agent tools, plan steps and issue runs can all reach the
 * embedded editor, and none of them has a React pane to read a `root` prop
 * from. They resolve here instead, on the same rule `action.git.*` already uses
 * for repos (`lib/workflow/nodes/source-control/index.ts`):
 *
 *   explicit argument → the bound Pro IDE → a readable throw.
 *
 * Deliberately no implicit spawn. Starting code-server is a visible,
 * multi-hundred-megabyte, window-stealing act; a workflow that wants it says so
 * with its own `autoStart` parameter, which is a separate decision from
 * *addressing* and therefore lives with the caller, not here.
 *
 * Deliberately no liveness probe either. The instance can exit between the
 * resolve and the call, so a check here would only ever be stale — callers let
 * the backend's own error speak, which is the one that describes what actually
 * went wrong.
 */
import { getActiveProIdeRoot } from "./pane-manager"

/**
 * Thrown when neither an explicit root nor a bound Pro IDE is available.
 *
 * A named class rather than a bare `Error` because the four caller families
 * present failure differently — a workflow node wraps it as non-retryable, an
 * agent tool returns it as tool output, a plan step fails the step — and each
 * needs to tell "you never opened the IDE" apart from "the IDE rejected this".
 */
export class ProIdeRootUnresolvedError extends Error {
  constructor(caller: string) {
    super(
      `${caller}: no Pro IDE is bound — pass an explicit "root", or open the ` +
        `Pro IDE editor once so it binds`
    )
    this.name = "ProIdeRootUnresolvedError"
  }
}

/**
 * Resolve the project root to drive, or throw {@link ProIdeRootUnresolvedError}.
 *
 * @param caller Node kind / tool name, prefixed onto the error so the user sees
 *   which step failed rather than a bare "no Pro IDE".
 * @param explicit A caller-supplied root. Blank and whitespace-only values count
 *   as absent: they arrive from optional form fields and template
 *   interpolations that resolved to nothing, and treating `""` as a real root
 *   would send the backend to canonicalize the empty string.
 */
export function resolveProIdeRoot(caller: string, explicit?: string | null): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  const bound = getActiveProIdeRoot()
  if (bound) return bound
  throw new ProIdeRootUnresolvedError(caller)
}
