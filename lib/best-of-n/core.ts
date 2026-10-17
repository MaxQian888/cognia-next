import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type {
  BestOfNCandidate,
  BestOfNGroup,
  BestOfNMutation,
  BestOfNProgress,
  StartBestOfN,
} from "@/types/best-of-n"
import type { BestOfNHost } from "./host"
import { TEAM_TOOL_NAMES } from "@/lib/claude/team-builtin-tools"
import { SESSION_PEER_TOOL_NAMES } from "@/lib/claude/session-peer-builtin-tools"

export interface BestOfNInput extends Omit<
  StartBestOfN,
  "ownerId" | "leaseDurationMs" | "targetIsNew"
> {
  targetIsNew?: boolean
  prompt: string
  projectId?: string
  /** Same approved acceptance profiles for every attempt. */
  requiredChecks?: string[]
}
export interface CandidateWorkspace {
  bundleId: string
  physicalRoot: string
  workspaceId: string
}
export interface CandidateResult {
  changesetId?: string
  headSha?: string
  hasChanges: boolean
  costUsd: number | null
}
export class BestOfNAttemptError extends Error {
  constructor(
    message: string,
    readonly costUsd: number | null,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "BestOfNAttemptError"
  }
}
export interface BestOfNExecution {
  prepare(group: BestOfNGroup, input: BestOfNInput): Promise<void>
  acquire(
    group: BestOfNGroup,
    candidate: BestOfNCandidate,
    input: BestOfNInput
  ): Promise<CandidateWorkspace>
  execute(input: {
    group: BestOfNGroup
    candidate: BestOfNCandidate
    workspace: CandidateWorkspace
    request: BestOfNInput
    grant: AgentCapabilityGrantV1
    signal: AbortSignal
  }): Promise<CandidateResult>
  stop(group: BestOfNGroup): Promise<void>
  finish(group: BestOfNGroup): Promise<void>
}
export interface BestOfNHandle {
  group: BestOfNGroup
  completion: Promise<BestOfNGroup>
}

export function candidateGrant(
  group: BestOfNGroup,
  candidate: BestOfNCandidate
): AgentCapabilityGrantV1 {
  return {
    schemaVersion: 1,
    source: { kind: "agent-team", id: candidate.candidateId },
    ...(candidate.agent.model ? { model: candidate.agent.model } : {}),
    ...(candidate.agent.provider ? { provider: candidate.agent.provider } : {}),
    maxTurns: 20,
    ...(group.budgetPolicy.maxCostUsd == null
      ? {}
      : { maxBudgetUsd: group.budgetPolicy.maxCostUsd / group.n }),
    // Fixed fan-out: an attempt cannot spawn more attempts or read its siblings.
    subagents: { only: [] },
    tools: {
      deny: [
        "Agent",
        "Task",
        "dispatch_agent",
        "spawn_task",
        ...Object.values(TEAM_TOOL_NAMES),
        ...Object.values(SESSION_PEER_TOOL_NAMES),
        "vector_search",
        "vector_add_document",
        "vector_delete_document",
      ],
    },
  }
}

/** No parent send, planner, result sharing, judge or synthesis exists in this driver. */
export function createBestOfNService(deps: {
  host: BestOfNHost
  execution: BestOfNExecution
  ownerId: string
  now?: () => number
  pollMs?: number
  leaseDurationMs?: number
}) {
  const { host, execution, ownerId } = deps
  const now = deps.now ?? Date.now
  const leaseDurationMs = deps.leaseDurationMs ?? 30_000
  const requests = new Map<string, Promise<BestOfNHandle>>()
  const running = new Map<string, { abort: AbortController; completion: Promise<BestOfNGroup> }>()
  const tails = new Map<string, Promise<unknown>>()
  const mutation = (group: BestOfNGroup): BestOfNMutation => ({
    groupId: group.groupId,
    expectedVersion: group.version,
    ownerId,
    leaseDurationMs,
  })
  function serialize<T>(
    groupId: string,
    operation: (group: BestOfNGroup) => Promise<T>
  ): Promise<T> {
    const previous = tails.get(groupId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await operation(await host.get(groupId))
          } catch (error) {
            // Integration completion may advance the same ledger between our read and CAS.
            if (
              attempt >= 2 ||
              !String(error instanceof Error ? error.message : error).includes(
                "best-of-N version conflict"
              )
            )
              throw error
          }
        }
      })
    tails.set(groupId, next)
    void next
      .finally(() => {
        if (tails.get(groupId) === next) tails.delete(groupId)
      })
      .catch(() => undefined)
    return next
  }
  const progress = (groupId: string, update: Omit<BestOfNProgress, "mutation">) =>
    serialize(groupId, (group) => host.progress({ ...update, mutation: mutation(group) }))
  const claim = (group: BestOfNGroup) => host.recover(mutation(group))

  async function acknowledgeStopped(group: BestOfNGroup): Promise<BestOfNGroup> {
    await execution.stop(group)
    for (const candidate of group.candidates.filter((item) => item.status === "cancelRequested")) {
      group = await progress(group.groupId, {
        candidateId: candidate.candidateId,
        status: "cancelled",
        hasChanges: false,
        costUsd: candidate.costUsd,
      })
    }
    return group
  }

  async function drive(
    group: BestOfNGroup,
    input: BestOfNInput,
    abort: AbortController
  ): Promise<BestOfNGroup> {
    let monitorError: unknown
    let ticking = false
    const tick = async () => {
      if (ticking || abort.signal.aborted) return
      ticking = true
      try {
        const current = await serialize(group.groupId, async (latest) => {
          if (!["preparing", "running"].includes(latest.phase)) return latest
          return host.recover(mutation(latest))
        })
        const duration = current.budgetPolicy.maxDurationMs ?? 600_000
        if (
          !["preparing", "running"].includes(current.phase) ||
          now() - current.createdAt >= duration
        ) {
          abort.abort(new Error("Best-of-N stopped or its duration budget expired"))
        }
      } catch (error) {
        monitorError = error
        abort.abort(error)
      } finally {
        ticking = false
      }
    }
    const timer = setInterval(() => {
      void tick()
    }, deps.pollMs ?? 1_000)
    const deadline = setTimeout(
      () => abort.abort(new Error("Best-of-N duration budget exhausted")),
      Math.max(0, (group.budgetPolicy.maxDurationMs ?? 600_000) - (now() - group.createdAt))
    )
    try {
      await execution.prepare(group, input)
      const attempts = await Promise.allSettled(
        group.candidates.map(async (candidate) => {
          if (candidate.status !== "pending") return
          let workspace: CandidateWorkspace | undefined
          try {
            abort.signal.throwIfAborted()
            workspace = await execution.acquire(group, candidate, input)
            await progress(group.groupId, {
              candidateId: candidate.candidateId,
              status: "running",
              workspaceBundleId: workspace.bundleId,
              physicalRoot: workspace.physicalRoot,
              hasChanges: false,
              costUsd: null,
            })
            abort.signal.throwIfAborted()
            const result = await execution.execute({
              group,
              candidate,
              workspace,
              request: input,
              grant: candidateGrant(group, candidate),
              signal: abort.signal,
            })
            await progress(group.groupId, {
              candidateId: candidate.candidateId,
              status: "succeeded",
              ...result,
            })
          } catch (error) {
            const current = await host.get(group.groupId)
            const row = current.candidates.find(
              (item) => item.candidateId === candidate.candidateId
            )
            if (row && ["pending", "running", "cancelRequested"].includes(row.status)) {
              await progress(group.groupId, {
                candidateId: candidate.candidateId,
                status: abort.signal.aborted ? "cancelled" : "failed",
                ...(workspace
                  ? { workspaceBundleId: workspace.bundleId, physicalRoot: workspace.physicalRoot }
                  : {}),
                hasChanges: false,
                costUsd: error instanceof BestOfNAttemptError ? error.costUsd : null,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        })
      )
      if (monitorError) throw monitorError
      const rejected = attempts.filter(
        (item): item is PromiseRejectedResult => item.status === "rejected"
      )
      if (rejected.length)
        throw new AggregateError(
          rejected.map((item) => item.reason),
          "Best-of-N progress could not be persisted"
        )
      const result = await host.get(group.groupId)
      await execution.finish(result)
      return result
    } catch (error) {
      // Even a failure before fan-out must leave a durable terminal/recovery record.
      const current = await host.get(group.groupId)
      for (const candidate of current.candidates.filter((c) =>
        ["pending", "running", "cancelRequested"].includes(c.status)
      )) {
        await progress(group.groupId, {
          candidateId: candidate.candidateId,
          status: candidate.status === "pending" ? "failed" : "recoveryRequired",
          hasChanges: false,
          costUsd: candidate.costUsd,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    } finally {
      clearInterval(timer)
      clearTimeout(deadline)
      if (abort.signal.aborted) await execution.stop(await host.get(group.groupId))
    }
  }

  function startBestOfN(input: BestOfNInput): Promise<BestOfNHandle> {
    const existing = requests.get(input.requestId)
    if (existing) return existing
    const allocation = (async () => {
      if (!input.prompt.trim() || input.candidates.length < 2 || input.candidates.length > 4)
        throw new Error("Best-of-N requires a prompt and 2–4 candidates")
      const { prompt: _prompt, projectId: _project, requiredChecks: _checks, ...request } = input
      const group = await host.start({
        ...request,
        targetIsNew: request.targetIsNew ?? true,
        budgetPolicy: {
          ...request.budgetPolicy,
          maxDurationMs: request.budgetPolicy.maxDurationMs ?? 600_000,
        },
        ownerId,
        leaseDurationMs,
      })
      const active = running.get(group.groupId)
      if (active) return { group, completion: active.completion }
      // A retry observes allocation; it never dispatches an already started candidate again.
      if (
        group.ownerId !== ownerId ||
        group.phase !== "preparing" ||
        group.candidates.some((candidate) => candidate.status !== "pending")
      ) {
        return { group, completion: Promise.resolve(group) }
      }
      const abort = new AbortController()
      const completion = drive(group, input, abort)
      running.set(group.groupId, { abort, completion })
      void completion.finally(() => running.delete(group.groupId)).catch(() => undefined)
      return { group, completion }
    })()
    requests.set(input.requestId, allocation)
    void allocation
      .finally(() => {
        if (requests.get(input.requestId) === allocation) requests.delete(input.requestId)
      })
      .catch(() => undefined)
    return allocation
  }

  return {
    startBestOfN,
    async cancel(groupId: string): Promise<BestOfNGroup> {
      const group = await serialize(groupId, async (current) =>
        host.cancel(mutation(await claim(current)))
      )
      running.get(groupId)?.abort.abort(new Error("Best-of-N cancelled"))
      await execution.stop(group)
      await running.get(groupId)?.completion
      return acknowledgeStopped(await host.get(groupId))
    },
    async select(groupId: string, candidateId: string, headSha: string): Promise<BestOfNGroup> {
      const group = await serialize(groupId, async (current) =>
        host.select({ mutation: mutation(await claim(current)), candidateId, headSha })
      )
      running.get(groupId)?.abort.abort(new Error("Best-of-N winner selected"))
      await execution.stop(group)
      await running.get(groupId)?.completion
      return acknowledgeStopped(await host.get(groupId))
    },
    async recover(groupId: string): Promise<BestOfNGroup> {
      if (running.has(groupId)) return host.get(groupId)
      let group = await serialize(groupId, (current) => host.recover(mutation(current)))
      // Rebind to durable evidence, never blindly replay a potentially writing turn.
      for (const candidate of group.candidates.filter((item) => item.status === "running")) {
        group = await progress(groupId, {
          candidateId: candidate.candidateId,
          status: "recoveryRequired",
          hasChanges: candidate.hasChanges,
          costUsd: candidate.costUsd,
          ...(candidate.changesetId && candidate.headSha
            ? { changesetId: candidate.changesetId, headSha: candidate.headSha }
            : {}),
          error: "Candidate execution was interrupted; inspect the workspace before retrying",
        })
      }
      if (
        group.phase === "recoveryRequired" ||
        group.phase === "cancelling" ||
        group.candidates.some((candidate) => candidate.status === "cancelRequested")
      )
        group = await acknowledgeStopped(group)
      return group
    },
    archive: (groupId: string) =>
      serialize(groupId, async (group) => host.archive(mutation(await claim(group)))),
  }
}
