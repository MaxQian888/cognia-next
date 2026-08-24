import type { Project } from "@/types"
import { primaryRootOf } from "@/lib/workspace/roots"

/**
 * Single source of truth for "which directory does this chat session run
 * in". The same chain feeds the model send path (`resolveSendOptions`) and
 * every UI surface that gates on a working directory (composer `!` shell
 * commands, `@` file references, custom slash-command scanning, the footer
 * cwd chip) — so the UI can never disagree with what a send would use.
 *
 * Priority: per-session override → the session's durable execution binding →
 * active workspace primary root → character default → app default.
 *
 * The execution binding sits above the workspace root because it names the
 * directory the agent is actually leased into. For a `managedWorktree` session
 * that is the bundle's alias path, NOT the source repository — resolving to the
 * workspace root there points every consumer (instruction discovery, the
 * sandbox placement, the UI cwd chip) at a different checkout than the one the
 * turn writes into. It stays below the hand-typed per-session override, which
 * remains the user's explicit last word.
 */
export interface EffectiveCwdInput {
  sessionWorkingDir?: string | null
  /**
   * The root resolved from `ChatSession.executionContext` — see
   * `resolveSessionWorkspaceRoot` (`lib/task-workspace/session-execution-context.ts`).
   * Undefined until a binding exists (a brand-new managed session's first turn,
   * or a device where the managed workspace is not materialized).
   */
  executionWorkspaceRoot?: string | null
  /** The workspace this session belongs to, or null when it has none. */
  activeProject?: Pick<Project, "roots"> | null
  characterWorkingDir?: string | null
  /** `appSettings.defaultWorkingDir`. */
  defaultWorkingDir?: string | null
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveEffectiveCwd(input: EffectiveCwdInput): string | undefined {
  return (
    nonEmpty(input.sessionWorkingDir) ??
    nonEmpty(input.executionWorkspaceRoot) ??
    (input.activeProject ? nonEmpty(primaryRootOf(input.activeProject)?.path) : undefined) ??
    nonEmpty(input.characterWorkingDir) ??
    nonEmpty(input.defaultWorkingDir)
  )
}
