/**
 * Load the Prompt Center overrides (ADR-0236) a CLI turn resolves against.
 *
 * The resolver reads an in-memory snapshot, never Dexie, and plain CLI chat
 * never opens the database. So before a turn's options are built, this opens
 * the CLI store and loads the snapshot, but only when the store can hold an
 * override: a user who never customized a prompt keeps the DB-free start.
 *
 * The CLI runs in a directory rather than a UI selection, so the workspace a
 * workspace-scoped override targets is the one that mounts the cwd, the same
 * rule the CLI's skill scoping uses.
 */

import { cliStoreMayHoldRows, ensureCliDb } from "../db/bootstrap"

export interface PrimeCliPromptOverridesDeps {
  /** Config home whose store is probed; defaults to the resolved `~/.cognia`. */
  home?: string
  /** Whether the store may hold override rows; defaults to probing the table files. */
  mayHoldRows?: () => boolean
  ensureDb?: () => Promise<unknown>
  loadSnapshot?: () => Promise<unknown>
  findWorkspaceId?: (cwd: string) => Promise<string | null>
}

export interface PrimedCliPromptOverrides {
  /** The workspace mounting the cwd, when overrides were loaded and one does. */
  workspaceId?: string
}

/**
 * Never throws: a store that cannot be opened leaves every slot on its shipped
 * text, which is what the resolver does with no snapshot anyway. The caller's
 * own database paths report open failures; this one has nothing to add.
 */
export async function primeCliPromptOverrides(
  cwd: string,
  deps: PrimeCliPromptOverridesDeps = {}
): Promise<PrimedCliPromptOverrides> {
  const mayHoldRows =
    deps.mayHoldRows ??
    (() => cliStoreMayHoldRows("promptOverrides", deps.home ? { home: deps.home } : {}))
  if (!mayHoldRows()) return {}
  try {
    await (deps.ensureDb ?? (() => ensureCliDb(deps.home ? { home: deps.home } : {})))()
    const loadSnapshot =
      deps.loadSnapshot ??
      (async () => (await import("@/lib/prompts/snapshot")).loadPromptOverrideSnapshot())
    await loadSnapshot()
    const findWorkspaceId =
      deps.findWorkspaceId ??
      (async (dir: string) => (await import("@/lib/db/projects")).findWorkspaceIdForPath(dir))
    const workspaceId = await findWorkspaceId(cwd)
    return workspaceId ? { workspaceId } : {}
  } catch {
    return {}
  }
}
