import type { Project } from "@/types"
import { primaryRootOf } from "@/lib/workspace/roots"

/**
 * Single source of truth for "which directory does this chat session run
 * in". The same chain feeds the model send path (`resolveSendOptions`) and
 * every UI surface that gates on a working directory (composer `!` shell
 * commands, `@` file references, custom slash-command scanning, the footer
 * cwd chip) — so the UI can never disagree with what a send would use.
 *
 * Priority: per-session override → active workspace primary root →
 * character default → app default. The active workspace sits above the
 * character default because it reflects "which project the user is
 * currently working in", a stronger signal than a character's standing
 * preference.
 */
export interface EffectiveCwdInput {
  sessionWorkingDir?: string | null
  /** The active workspace (project), or null when none is active. */
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
    (input.activeProject ? nonEmpty(primaryRootOf(input.activeProject)?.path) : undefined) ??
    nonEmpty(input.characterWorkingDir) ??
    nonEmpty(input.defaultWorkingDir)
  )
}
