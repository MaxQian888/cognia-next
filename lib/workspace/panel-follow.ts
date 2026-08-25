/**
 * Which directory a side panel is looking at.
 *
 * # The three disagreeing answers this replaces
 *
 * Before this, the terminal, the editor and Source Control each computed their
 * root differently and none of them read the conversation's execution context:
 *
 * - the terminal took `project.terminalConfig.cwd` → `project.rootDir`;
 * - the editor took `session.projectId` → that project's primary root;
 * - Source Control kept ONE global `rootDir`, auto-bound by a module-scoped
 *   guard that made a manual rebind stick until the next workspace switch.
 *
 * So a conversation running in a managed worktree got a terminal in the source
 * repository, an editor in the source repository, and a git panel on whatever
 * was last bound. Every tool the agent was working through pointed somewhere
 * other than where the agent was working.
 *
 * # Follow, and pin only where comparing is the point
 *
 * The default is to follow the conversation's execution root, because that is
 * where its commands actually run. Pinning is offered only to panels whose job
 * includes comparison — Source Control, the editor, search: "what does this
 * look like on main" is a real question. Execution panels (terminal, schedule,
 * the conversation list) always follow, because a terminal pinned to a
 * directory the agent is not working in is a loaded gun.
 *
 * # The target is always visible
 *
 * A panel that silently retargets is worse than one that needs a click: the
 * user runs `rm -rf build` believing they know where they are. Every consumer
 * renders the resolved root, and `PanelRootTarget.managed` is what lets it say
 * "this is a worktree alias, not your checkout".
 */

import type { SessionExecutionContext } from "@/types/execution-context"
import type { Project } from "@/types"

import { resolveExecutionRoot, type ExecutionRootSource } from "./session-root"

/** Panels that may be pinned away from the conversation they belong to. */
export const PINNABLE_PANELS = ["sourceControl", "editor", "search"] as const

/** Panels that must always follow. See the header. */
export const FOLLOWING_PANELS = ["terminal", "schedule", "conversations"] as const

export type PinnablePanel = (typeof PINNABLE_PANELS)[number]
export type FollowingPanel = (typeof FOLLOWING_PANELS)[number]
export type WorkspacePanel = PinnablePanel | FollowingPanel

/** Whether a panel is allowed to be pinned off the current conversation. */
export function isPinnablePanel(panel: string): panel is PinnablePanel {
  return (PINNABLE_PANELS as readonly string[]).includes(panel)
}

export interface PanelRootTarget {
  /** Absolute directory the panel should operate on. Null when nothing resolves. */
  root: string | null
  /** Where the answer came from — drives the label, not just diagnostics. */
  source: "pinned" | ExecutionRootSource
  /**
   * True when `root` is a managed worktree alias rather than the user's own
   * checkout. The panel must say so: an editor silently showing a worktree
   * copy of a file is how someone edits the wrong tree for ten minutes.
   */
  managed: boolean
}

export interface ResolvePanelRootInput {
  /** The conversation the panel is bound to, if any. */
  executionContext?: SessionExecutionContext | null
  /** The workspace on screen. */
  activeProject?: Pick<Project, "roots"> | null
  /**
   * A root the user pinned this panel to. Honoured only for a pinnable panel —
   * a pin on an execution panel is ignored rather than obeyed, so a stale
   * persisted pin can never point a terminal at the wrong tree.
   */
  pinnedRoot?: string | null
  panel: WorkspacePanel
}

/**
 * Resolve one panel's directory: pin (pinnable panels only) → the
 * conversation's execution root → the workspace's primary root → nothing.
 */
export function resolvePanelRoot(input: ResolvePanelRootInput): PanelRootTarget {
  // The follow chain itself lives in `session-root.ts` — panels and the
  // non-panel surfaces must not be able to answer "which directory"
  // differently, so a panel adds only the pin layer on top of the one rule.
  const followed = resolveExecutionRoot({
    executionContext: input.executionContext,
    project: input.activeProject,
  })

  const pinned = input.pinnedRoot?.trim()
  if (pinned && isPinnablePanel(input.panel)) {
    return {
      root: pinned,
      source: "pinned",
      // A pin onto the conversation's OWN managed worktree is still a
      // worktree. Hardcoding `false` here rendered a pinned worktree with the
      // plain folder icon — exactly the "looks like an ordinary checkout"
      // mistake `managed` exists to prevent. A pin anywhere else is a
      // directory this resolver knows nothing about, so it stays false.
      managed: pinned === followed.root && followed.managed,
    }
  }

  return followed
}

/**
 * Whether a pin is still meaningful.
 *
 * A pin equal to what the panel would follow anyway is noise — it makes the
 * header claim a divergence that does not exist, and the user cannot tell
 * whether clearing it will move anything. Callers drop such a pin on write.
 */
export function pinDiverges(
  pinnedRoot: string | null | undefined,
  followed: string | null
): boolean {
  const pinned = pinnedRoot?.trim()
  if (!pinned) return false
  return pinned !== (followed ?? "")
}

/**
 * Reconcile a panel whose PIN IS ITS ROOT SELECTION.
 *
 * The editor already had a root switcher — main repo plus every discovered
 * worktree — persisted as `rootKey`. Bolting a separate pin onto it would have
 * produced two controls answering "which directory", which is how surfaces
 * start disagreeing. So the selection is the pin: selecting the followed root
 * means following, selecting any other root means pinned, and there is exactly
 * one stored field.
 *
 * The subtle part is a follow target that MOVES — the user switches to another
 * conversation, or a managed worktree finishes materializing. An editor that
 * was following must move with it; an editor the user deliberately pinned must
 * not. `previousFollowed` is what separates those two: a selection equal to the
 * old follow target was following, not pinned at a coincidentally equal path.
 */
export interface ReconcileSelectedRootInput {
  /** The persisted selection, if any. */
  selected?: string | null
  /** Where this panel would follow to right now. */
  followed?: string | null
  /** Where it would have followed to on the previous evaluation. */
  previousFollowed?: string | null
  /** Roots the panel can actually select. A selection outside this is stale. */
  available: readonly string[]
}

export interface ReconciledRoot {
  selected: string | null
  /** True when the selection deliberately diverges from the follow target. */
  pinned: boolean
}

export function reconcileSelectedRoot(input: ReconcileSelectedRootInput): ReconciledRoot {
  const available = input.available.filter((path) => path.trim())
  const followed = input.followed?.trim() || null
  const previous = input.previousFollowed?.trim() || null
  const raw = input.selected?.trim() || null

  // A selection that is no longer offered (a worktree that was removed, a
  // stale persisted path) must not hold the editor on a directory that is
  // gone. Following is the safe landing, not the first entry in the list.
  const selectable = raw && available.includes(raw) ? raw : null

  let selected = selectable
  if (!selected) {
    selected = followed && available.includes(followed) ? followed : (available[0] ?? followed)
  } else if (previous && selected === previous && followed && followed !== previous) {
    // It was following, and the target moved. Move with it.
    selected = available.includes(followed) ? followed : selected
  }

  return {
    selected: selected ?? null,
    pinned: Boolean(followed && selected && selected !== followed),
  }
}
