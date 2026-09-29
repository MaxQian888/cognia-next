import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"
import { truncateLine } from "@/lib/fleet/format"
import { primaryRootOf } from "@/lib/workspace/roots"
import { resolveCoordinatorConfig } from "./config"
import { deriveThreadState, type ThreadBoardState } from "./thread-state"

/**
 * The coordinator's per-turn view of its project: preferences and the recent
 * threads with their state. Rebuilt every turn from the live rows, so the
 * coordinator never works from a stale memory of what its threads are doing —
 * and never needs its whole history in context to know.
 */

export const DIGEST_MAX_THREADS = 12
export const DIGEST_SUMMARY_MAX_CHARS = 400
export const DIGEST_MAX_CHARS = 6_000

function preferenceLines(project: Pick<Project, "coordinator">): string[] {
  const { preferences, threadExecution } = resolveCoordinatorConfig(project)
  return [
    `- Threads run in: ${threadExecution === "auto" ? "their own worktree when the root is a git repository" : threadExecution}`,
    `- Propose before starting: ${preferences.proposeBeforeStart ? "yes — use propose_threads" : "no"}`,
    `- Max concurrent threads: ${preferences.maxConcurrentThreads ?? "no limit set"}`,
    `- Daily thread limit: ${preferences.dailyThreadCap}`,
    `- Auto-fix pull requests: ${preferences.autoFixPr ? "on" : "off"}`,
  ]
}

/**
 * The workspace's roots, when there is a choice to make: `spawn_thread` takes a
 * `root_id`, and the coordinator can only name one it has been shown.
 */
function rootLines(project: Partial<Pick<Project, "roots">>): string[] {
  const roots = project.roots ?? []
  if (roots.length < 2) return []
  const primary = primaryRootOf(project)
  return [
    "",
    "Roots (pass root_id to spawn_thread for work outside the primary):",
    ...roots.map(
      (root) =>
        `- ${root.id}: ${root.label?.trim() || root.path}${root.id === primary?.id ? " (primary)" : ""}`
    ),
  ]
}

export interface DigestThreadInput {
  thread: ChatSession
  status: ChatStatus
  pendingApprovals: number
  pr?: PrDerivedStatus
}

export function buildCoordinatorContextSection(
  project: Pick<Project, "coordinator"> & Partial<Pick<Project, "roots">>,
  threads: readonly DigestThreadInput[],
  now: number
): string {
  const states = threads.map((input) => ({
    ...input,
    state: deriveThreadState({
      thread: input.thread,
      status: input.status,
      pendingApprovals: input.pendingApprovals,
      pr: input.pr,
      now,
    }),
  }))
  const counts = new Map<ThreadBoardState, number>()
  for (const { state } of states) counts.set(state, (counts.get(state) ?? 0) + 1)
  const countLine = [...counts.entries()].map(([state, n]) => `${state}: ${n}`).join(", ")

  const recent = states
    .filter(({ state }) => state !== "resolved")
    .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)
    .slice(0, DIGEST_MAX_THREADS)
    .map(({ thread, state, pr: prStatus }) => {
      const branch = thread.executionContext?.branch
        ? ` · branch ${thread.executionContext.branch}`
        : ""
      const pr = thread.projectThread?.prRef?.url
        ? ` · PR ${thread.projectThread.prRef.url}${prStatus ? ` (${prStatus})` : ""}`
        : ""
      const result = thread.attachedChild?.result?.summary
      return [
        `- ${thread.title} (${thread.id}) — ${state}${branch}${pr}`,
        ...(result ? [`  last result: ${truncateLine(result, DIGEST_SUMMARY_MAX_CHARS)}`] : []),
      ].join("\n")
    })

  const body = [
    "## Project status",
    "Preferences:",
    ...preferenceLines(project),
    ...rootLines(project),
    "",
    threads.length === 0 ? "Threads: none yet." : `Threads (${countLine}):`,
    ...recent,
  ].join("\n")
  return body.length <= DIGEST_MAX_CHARS ? body : `${body.slice(0, DIGEST_MAX_CHARS - 1)}…`
}
