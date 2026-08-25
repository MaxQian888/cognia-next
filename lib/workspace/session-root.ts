/**
 * Where a conversation actually works — the resolver every non-panel surface
 * was missing.
 *
 * # The half that ADR-0144 left open
 *
 * `resolvePanelRoot` gave the side panels one rule. Everything that is not a
 * panel kept calling `resolveSessionProjectRoot`, which answers a different
 * question: it returns the WORKSPACE's primary root, and a workspace's primary
 * root is not where a worktree-bound conversation runs. Five surfaces were
 * still on it, and three of them were wrong in a way the user could feel:
 *
 * - an IM-resumed turn was handed the source repository as its `workspaceRoot`,
 *   so an agent leased into a worktree wrote into the checkout it was cut from;
 * - "open this edit in review" compares the agent's absolute path against the
 *   root it resolves, so a worktree edit failed the containment check and the
 *   click did nothing at all — no error, no panel, no clue;
 * - the editor plugin tool resolved the same wrong root, so a plugin reading
 *   "the open file" read a different tree than the agent had just edited.
 *
 * # One rule, two entry points
 *
 * `resolveExecutionRoot` IS the rule: the conversation's execution root, then
 * the workspace's primary root, then nothing. `resolvePanelRoot` adds the pin
 * layer on top of it for panels; `resolveSessionExecutionRoot` adds session →
 * workspace lookup for everything else. Neither re-implements the chain, so
 * "which directory" cannot drift back apart into two answers.
 *
 * The workspace fallback is deliberate and is NOT a guess: a conversation with
 * no execution binding yet (a brand-new chat's first turn, or a device where
 * the managed workspace is not materialized) genuinely runs in the workspace
 * root. What was wrong before was reaching for it while a binding existed.
 */

import type { SessionExecutionContext } from "@/types/execution-context"
import type { Project } from "@/types"

import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { primaryRootOf } from "./roots"

/** Where a directory answer came from. Drives labels, not only diagnostics. */
export type ExecutionRootSource = "execution" | "workspace" | "none"

export interface ExecutionRootTarget {
  /** Absolute directory, or null when nothing resolves. */
  root: string | null
  source: ExecutionRootSource
  /**
   * True when `root` is a managed worktree alias rather than the user's own
   * checkout. Surfaces that show a path must say so — a file list silently
   * showing a worktree copy is how someone edits the wrong tree for ten
   * minutes.
   */
  managed: boolean
}

export const NO_EXECUTION_ROOT: ExecutionRootTarget = Object.freeze({
  root: null,
  source: "none",
  managed: false,
})

export interface ResolveExecutionRootInput {
  /** The conversation's durable binding, if it has one yet. */
  executionContext?: SessionExecutionContext | null
  /** The workspace the conversation belongs to. */
  project?: Pick<Project, "roots"> | null
}

/**
 * The chain: the conversation's execution root → the workspace's primary root
 * → nothing.
 */
export function resolveExecutionRoot(input: ResolveExecutionRootInput): ExecutionRootTarget {
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

  const workspaceRoot = input.project ? primaryRootOf(input.project)?.path?.trim() : undefined
  if (workspaceRoot) return { root: workspaceRoot, source: "workspace", managed: false }

  return NO_EXECUTION_ROOT
}

function isManagedRoot(context: SessionExecutionContext, root: string): boolean {
  if (context.workspaceBinding?.kind !== "managed") return false
  const projectRoot = context.projectRoot?.trim()
  return !projectRoot || projectRoot !== root
}

/** A conversation, as far as this resolver is concerned. */
export interface SessionRootSubject {
  projectId?: string
  executionContext?: SessionExecutionContext
}

export interface SessionExecutionRootTarget extends ExecutionRootTarget {
  /**
   * The workspace the conversation belongs to, when it is loaded. Present even
   * when `root` is null, so a caller can tell "no workspace" apart from
   * "workspace with no root" — they need different empty states.
   */
  project?: Pick<Project, "id" | "roots">
}

/**
 * Resolve one conversation's working directory against a loaded workspace list.
 *
 * A session naming a workspace that is not in `projects` (deleted, or not
 * loaded yet) resolves to no project rather than falling back to whatever is
 * active — falling back re-introduces exactly the mis-attribution this exists
 * to prevent. A session naming NO workspace resolves to no project too; callers
 * that legitimately want the on-screen workspace pass it as `fallbackProject`.
 */
export function resolveSessionExecutionRoot(
  session: SessionRootSubject | null | undefined,
  projects: readonly Pick<Project, "id" | "roots">[],
  fallbackProject?: Pick<Project, "id" | "roots"> | null
): SessionExecutionRootTarget {
  const project = session?.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : (fallbackProject ?? undefined)

  const target = resolveExecutionRoot({
    executionContext: session?.executionContext,
    project,
  })
  return project ? { ...target, project } : target
}

/** The path alone, for callers that only ever wanted a string. */
export function sessionExecutionRootPath(
  session: SessionRootSubject | null | undefined,
  projects: readonly Pick<Project, "id" | "roots">[]
): string | undefined {
  return resolveSessionExecutionRoot(session, projects).root ?? undefined
}
