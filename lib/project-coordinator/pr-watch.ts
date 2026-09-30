import type { ChatSession } from "@cognia/agent-config-types"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import { GITHUB_DOT_COM, type GithubHost } from "@/lib/github/host"
import { fetchPrObservation } from "@/lib/github/pr-observe/fetch"
import { bindingRef, type PrWatchTarget } from "@/lib/ai/agent/team/pr-feedback/binding"
import {
  createRealPrFeedbackTimers,
  PrFeedbackController,
  type PrFeedbackDeps,
  type PrObservationRecord,
} from "@/lib/ai/agent/team/pr-feedback/observer"
import type { PrNudge } from "@/lib/ai/agent/team/pr-feedback/reactions"
import {
  createResolveOctokit,
  createResolveTeamRepo,
  type ResolvedTeamRepo,
} from "@/lib/ai/agent/team/pr-feedback/resolvers"
import {
  getSessionPrObservation,
  recordSessionPrObservation,
} from "@/lib/db/session-pr-observations"
import { getSession, updateSession } from "@/lib/db/sessions"
import { resolveCoordinatorConfig } from "./config"
import { getProject } from "./project-access"
import { sendToThread } from "./thread-runtime"

/**
 * PR watch for project threads (ADR-0204) — the same observer, reaction engine
 * and fetcher the Agent Team PR loop uses, keyed by thread instead of teammate.
 * A thread that pushed a branch is tracked; the PR it opens is found by that
 * branch. On CI failure, requested changes or a conflict, the nudge is sent
 * into the thread when the project's `autoFixPr` preference is on; otherwise
 * the board shows the PR state and the user decides.
 */

export interface ThreadPrBinding extends PrWatchTarget {
  sessionId: string
  projectId: string
  /** The repository's GitHub deployment (ADR-0176); github.com when absent. */
  host?: GithubHost
}

/** Octokits are per deployment and repository: `acme/app` may exist on both. */
function clientKey(binding: Pick<ThreadPrBinding, "repo" | "host">): string {
  return `${(binding.host ?? GITHUB_DOT_COM).id}:${binding.repo}`
}

export interface PrWatchDeps {
  resolveRepo: (workingDir: string) => Promise<ResolvedTeamRepo | null>
  resolveOctokit: (repoFullName: string, host?: GithubHost) => Promise<OctokitLike | null>
  fetch: typeof fetchPrObservation
  persist: (record: PrObservationRecord<ThreadPrBinding>) => Promise<void>
  loadSignature: PrFeedbackDeps<ThreadPrBinding>["loadSignature"]
  deliver: (binding: ThreadPrBinding, nudge: PrNudge) => void
  onError: (binding: ThreadPrBinding, error: unknown) => void
  timers: Pick<PrFeedbackDeps, "now" | "setTimer" | "clearTimer">
  pollIntervalMs: number
}

export const THREAD_PR_POLL_INTERVAL_MS = 60_000

/** Record the observation and mirror the PR reference onto the thread row. */
export async function persistThreadPr(
  record: PrObservationRecord<ThreadPrBinding>,
  deps: {
    record: typeof recordSessionPrObservation
    getSession: typeof getSession
    updateSession: (id: string, patch: Partial<ChatSession>) => Promise<unknown>
  } = { record: recordSessionPrObservation, getSession, updateSession }
): Promise<void> {
  const { binding, observation } = record
  const prUrl = observation.pr.url || binding.prUrl || ""
  const at = observation.observedAt
  await deps.record({
    id: binding.sessionId,
    sessionId: binding.sessionId,
    projectId: binding.projectId,
    prUrl,
    ...(observation.pr.number ? { prNumber: observation.pr.number } : {}),
    branch: binding.branch,
    repo: binding.repo,
    facts: observation,
    derivedStatus: record.derivedStatus,
    lastNudgeSignature: record.signature,
    observedAt: at,
    updatedAt: at,
  })
  const thread = await deps.getSession(binding.sessionId)
  const current = thread?.projectThread
  if (
    !current ||
    (current.prRef?.url === prUrl && current.prRef.number === observation.pr.number)
  ) {
    return
  }
  await deps.updateSession(binding.sessionId, {
    projectThread: {
      ...current,
      prRef: {
        repo: binding.repo,
        branch: binding.branch,
        ...(observation.pr.number ? { number: observation.pr.number } : {}),
        ...(prUrl ? { url: prUrl } : {}),
      },
    },
  })
}

/** Deliver a nudge into the thread, or leave it to the board, per the project's preference. */
export function deliverThreadNudge(
  binding: ThreadPrBinding,
  nudge: PrNudge,
  deps: {
    autoFix: (projectId: string) => boolean
    send: (threadId: string, text: string) => Promise<boolean>
  } = {
    autoFix: (projectId) => resolveCoordinatorConfig(getProject(projectId)).preferences.autoFixPr,
    send: sendToThread,
  }
): void {
  if (!deps.autoFix(binding.projectId)) return
  void deps.send(binding.sessionId, nudge.message)
}

function defaultDeps(): PrWatchDeps {
  return {
    resolveRepo: createResolveTeamRepo(),
    resolveOctokit: createResolveOctokit(),
    fetch: fetchPrObservation,
    persist: (record) => persistThreadPr(record),
    loadSignature: async (binding) =>
      (await getSessionPrObservation(binding.sessionId))?.lastNudgeSignature,
    deliver: (binding, nudge) => deliverThreadNudge(binding, nudge),
    onError: (binding, error) =>
      console.warn("project thread PR watch failed", { sessionId: binding.sessionId, error }),
    timers: createRealPrFeedbackTimers(),
    pollIntervalMs: THREAD_PR_POLL_INTERVAL_MS,
  }
}

/**
 * One watcher per app process. Tracks threads whose branch is known, keyed by
 * thread; the octokit for each repository is resolved once and reused.
 */
export class ProjectPrWatch {
  private readonly octokits = new Map<string, OctokitLike>()
  private readonly bindings = new Map<string, ThreadPrBinding>()
  private readonly controller: PrFeedbackController<ThreadPrBinding>

  constructor(private readonly deps: PrWatchDeps = defaultDeps()) {
    this.controller = new PrFeedbackController<ThreadPrBinding>({
      identify: (binding) => ({ key: binding.sessionId, recipient: binding.sessionId }),
      ...deps.timers,
      pollIntervalMs: deps.pollIntervalMs,
      fetch: async (binding, prev) => {
        const octokit = this.octokits.get(clientKey(binding))
        if (!octokit) throw new Error(`No GitHub client for ${binding.repo}`)
        return deps.fetch(octokit, binding.repo, bindingRef(binding), prev, deps.timers.now())
      },
      persist: deps.persist,
      loadSignature: deps.loadSignature,
      deliver: deps.deliver,
      onError: deps.onError,
    })
  }

  /** The binding for a thread, when it has a branch on a configured GitHub repository. */
  async bindingFor(thread: ChatSession): Promise<ThreadPrBinding | null> {
    const context = thread.executionContext
    const branch = context?.branch
    const workingDir = context?.worktreePath ?? context?.projectRoot ?? thread.workingDir
    if (!branch || !workingDir || !thread.projectId) return null
    const repo = await this.deps.resolveRepo(workingDir)
    if (!repo || branch === repo.defaultBranch) return null
    return {
      sessionId: thread.id,
      projectId: thread.projectId,
      repo: repo.fullName,
      host: repo.host,
      branch,
      ...(thread.projectThread?.prRef?.number
        ? { prNumber: thread.projectThread.prRef.number }
        : {}),
      ...(thread.projectThread?.prRef?.url ? { prUrl: thread.projectThread.prRef.url } : {}),
    }
  }

  /** Start watching a thread's PR. Idempotent; false when it cannot be watched. */
  async track(thread: ChatSession): Promise<boolean> {
    if (this.bindings.has(thread.id)) return true
    const binding = await this.bindingFor(thread)
    if (!binding) return false
    const key = clientKey(binding)
    if (!this.octokits.has(key)) {
      const octokit = await this.deps.resolveOctokit(binding.repo, binding.host)
      if (!octokit) return false
      this.octokits.set(key, octokit)
    }
    this.bindings.set(thread.id, binding)
    this.controller.track(binding)
    return true
  }

  untrack(threadId: string): void {
    const binding = this.bindings.get(threadId)
    if (!binding) return
    this.bindings.delete(threadId)
    this.controller.untrack(binding)
  }

  tracked(): string[] {
    return [...this.bindings.keys()]
  }

  /** Watch exactly the threads that should be watched; drop the rest. */
  async sync(threads: readonly ChatSession[]): Promise<void> {
    const wanted = new Map(
      threads
        .filter((thread) => thread.projectThread?.resolvedAt === undefined)
        .map((thread) => [thread.id, thread])
    )
    for (const id of this.tracked()) if (!wanted.has(id)) this.untrack(id)
    for (const thread of wanted.values()) await this.track(thread)
  }

  dispose(): void {
    this.controller.dispose()
    this.bindings.clear()
  }

  /** The GitHub client resolved for a repository, for one-off actions (merge, create PR). */
  octokitFor(repo: string): OctokitLike | undefined {
    return this.octokits.get(repo)
  }
}

let shared: ProjectPrWatch | undefined

export function getProjectPrWatch(): ProjectPrWatch {
  shared ??= new ProjectPrWatch()
  return shared
}
