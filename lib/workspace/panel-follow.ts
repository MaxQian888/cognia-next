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

import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { primaryRootOf } from "./roots"

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
  source: "pinned" | "execution" | "workspace" | "none"
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

const NO_TARGET: PanelRootTarget = Object.freeze({
  root: null,
  source: "none",
  managed: false,
})

/**
 * Resolve one panel's directory: pin (pinnable panels only) → the
 * conversation's execution root → the workspace's primary root → nothing.
 */
export function resolvePanelRoot(input: ResolvePanelRootInput): PanelRootTarget {
  const pinned = input.pinnedRoot?.trim()
  if (pinned && isPinnablePanel(input.panel)) {
    return { root: pinned, source: "pinned", managed: false }
  }

  const context = input.executionContext
  if (context) {
    const executionRoot = resolveSessionWorkspaceRoot(context)?.trim()
    if (executionRoot) {
      return {
        root: executionRoot,
        // "managed" is about the DIRECTORY, not the binding's label: a managed
        // binding whose primary alias resolves to the plain project root is
        // not something to warn about.
        managed: isManagedRoot(context, executionRoot),
        source: "execution",
      }
    }
  }

  const workspaceRoot = input.activeProject
    ? primaryRootOf(input.activeProject)?.path?.trim()
    : undefined
  if (workspaceRoot) return { root: workspaceRoot, source: "workspace", managed: false }

  return NO_TARGET
}

function isManagedRoot(context: SessionExecutionContext, root: string): boolean {
  if (context.workspaceBinding?.kind !== "managed") return false
  const projectRoot = context.projectRoot?.trim()
  return !projectRoot || projectRoot !== root
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
