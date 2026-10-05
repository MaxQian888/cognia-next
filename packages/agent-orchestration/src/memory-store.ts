/**
 * The reference {@link TeamRunStore}: in-process maps under the shared rules
 * (ADR-0217). Hosts without a database (tests, a CLI dry run, a headless
 * smoke) use it, and it pins what the contract means for every other store.
 *
 * Atomicity: each operation is one synchronous critical section; an
 * `atomically` block runs alone (other callers queue behind it) against a
 * snapshot that is restored if the block throws.
 */

import { createContentObject, verifiedContent } from "./content"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamContentObject,
  AgentTeamDecision,
  AgentTeamEvidence,
  AgentTeamRunRecord,
  AgentTeamSteeringReceipt,
  AgentTeamTrajectoryEvent,
} from "./records"
import {
  assertChildBoundary,
  assertDecisionBoundary,
  assertRunBoundary,
  canAdvanceRemoteEvent,
  checkpointChildPatch,
  dispatchLeaseClaimPatch,
  dispatchLeaseRenewPatch,
  dispatchLeaseSettlePatch,
  evidenceInScope,
  latestChildFor,
  matchesControlState,
  nextTrajectoryEvent,
  pendingSteering,
  selectRecoveryCandidates,
  sortDecisions,
  steeringQueuedChildPatch,
  steeringReceiptPatch,
  steeringResolvedChildPatch,
  trajectoryChildPatch,
} from "./rules"
import type { TeamRunStore } from "./store"

interface State<TConstraints> {
  runs: Map<string, AgentTeamRunRecord<TConstraints>>
  children: Map<string, AgentTeamChildRun>
  trajectory: Map<string, AgentTeamTrajectoryEvent[]>
  checkpoints: Map<string, AgentTeamCheckpoint[]>
  steering: Map<string, AgentTeamSteeringReceipt>
  evidence: Map<string, AgentTeamEvidence>
  decisions: Map<string, AgentTeamDecision>
  content: Map<string, AgentTeamContentObject>
}

export interface MemoryTeamRunStoreOptions {
  /** Checkpoint id factory; defaults to `team-checkpoint-<uuid>`. */
  newId?: (prefix: string) => string
}

function emptyState<TConstraints>(): State<TConstraints> {
  return {
    runs: new Map(),
    children: new Map(),
    trajectory: new Map(),
    checkpoints: new Map(),
    steering: new Map(),
    evidence: new Map(),
    decisions: new Map(),
    content: new Map(),
  }
}

function snapshot<TConstraints>(state: State<TConstraints>): State<TConstraints> {
  return {
    runs: new Map([...state.runs].map(([k, v]) => [k, { ...v }])),
    children: new Map([...state.children].map(([k, v]) => [k, { ...v }])),
    trajectory: new Map([...state.trajectory].map(([k, v]) => [k, [...v]])),
    checkpoints: new Map([...state.checkpoints].map(([k, v]) => [k, [...v]])),
    steering: new Map([...state.steering].map(([k, v]) => [k, { ...v }])),
    evidence: new Map([...state.evidence].map(([k, v]) => [k, { ...v }])),
    decisions: new Map([...state.decisions].map(([k, v]) => [k, { ...v }])),
    content: new Map(state.content),
  }
}

function defaultId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

/** Drop keys whose patch value is `undefined`, as a database update would. */
function apply<T extends object>(row: T, patch: Partial<NoInfer<T>>): T {
  const next = { ...row, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key]
  }
  return next
}

export function createMemoryTeamRunStore<TConstraints = unknown>(
  options: MemoryTeamRunStoreOptions = {}
): TeamRunStore<TConstraints> {
  const newId = options.newId ?? defaultId
  let state = emptyState<TConstraints>()
  let tail: Promise<unknown> = Promise.resolve()

  /** Queue behind the active atomic block, if any. */
  const queued = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => undefined)
    return result
  }

  const ops: Omit<TeamRunStore<TConstraints>, "atomically"> = {
    async createRun(run) {
      assertRunBoundary(run)
      if (state.runs.has(run.id)) throw new Error(`Durable AgentTeam run already exists: ${run.id}`)
      state.runs.set(run.id, { ...run })
    },
    async getRun(id) {
      const run = state.runs.get(id)
      return run ? { ...run } : undefined
    },
    async updateRun(id, patch) {
      const run = state.runs.get(id)
      if (!run) return false
      state.runs.set(id, apply(run, patch))
      return true
    },
    async updateRunIfCurrent(id, expected, patch) {
      const run = state.runs.get(id)
      if (!matchesControlState(run, expected)) return false
      state.runs.set(id, apply(run as AgentTeamRunRecord<TConstraints>, patch))
      return true
    },
    async listRuns(teamId) {
      return [...state.runs.values()]
        .filter((run) => teamId === undefined || run.teamId === teamId)
        .map((run) => ({ ...run }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async listRecoveryCandidates() {
      return selectRecoveryCandidates([...state.runs.values()].map((run) => ({ ...run })))
    },

    async createChild(child) {
      assertChildBoundary(child)
      if (state.children.has(child.id)) {
        throw new Error(`Durable AgentTeam child already exists: ${child.id}`)
      }
      state.children.set(child.id, { ...child })
    },
    async getChild(id) {
      const child = state.children.get(id)
      return child ? { ...child } : undefined
    },
    async listChildren(runId) {
      return [...state.children.values()]
        .filter((child) => child.runId === runId)
        .map((child) => ({ ...child }))
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    async findLatestChild(runId, taskId, teammateId) {
      const latest = latestChildFor(
        [...state.children.values()].filter((child) => child.runId === runId),
        taskId,
        teammateId
      )
      return latest ? { ...latest } : undefined
    },
    async updateChild(id, patch) {
      const child = state.children.get(id)
      if (!child) return false
      state.children.set(id, apply(child, patch))
      return true
    },
    async updateChildIfCurrent(id, expected, patch) {
      const child = state.children.get(id)
      if (!matchesControlState(child, expected)) return false
      state.children.set(id, apply(child as AgentTeamChildRun, patch))
      return true
    },

    async claimDispatchLease(input) {
      const child = state.children.get(input.childRunId)
      if (!child) return undefined
      const patch = dispatchLeaseClaimPatch(child, input)
      if (!patch) return undefined
      const next = apply(child, patch)
      state.children.set(child.id, next)
      return { ...next }
    },
    async renewDispatchLease(childRunId, expectedLeaseId, now, ttlMs) {
      const child = state.children.get(childRunId)
      const patch = dispatchLeaseRenewPatch(child, expectedLeaseId, now, ttlMs)
      if (!child || !patch) return false
      state.children.set(childRunId, apply(child, patch))
      return true
    },
    async settleDispatchLease(childRunId, expectedLeaseId, now) {
      const child = state.children.get(childRunId)
      const patch = dispatchLeaseSettlePatch(child, expectedLeaseId, now)
      if (!child || !patch) return false
      state.children.set(childRunId, apply(child, patch))
      return true
    },
    async advanceRemoteEvent(childRunId, expectedPreviousEventId, eventId, now, envelope) {
      const object = envelope
        ? await createContentObject(JSON.stringify(envelope.event), "application/json", now)
        : undefined
      const child = state.children.get(childRunId)
      if (!canAdvanceRemoteEvent(child, expectedPreviousEventId)) return false
      if (envelope && object) {
        if (child.runId !== envelope.runId) throw new Error("Remote event belongs to another run")
        state.content.set(object.hash, object)
        appendEvent({
          runId: envelope.runId,
          childRunId,
          kind: "remote_event",
          correlationId: eventId,
          contentHash: object.hash,
          createdAt: now,
        })
      }
      const current = state.children.get(childRunId)!
      state.children.set(childRunId, apply(current, { lastRemoteEventId: eventId, updatedAt: now }))
      return true
    },

    async appendTrajectory(input, content) {
      const object = content
        ? await createContentObject(content.data, content.mimeType, input.createdAt)
        : undefined
      if (object) state.content.set(object.hash, object)
      return appendEvent(input, object?.hash)
    },
    async listTrajectory(runId, afterSequence = 0) {
      return (state.trajectory.get(runId) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .map((event) => ({ ...event }))
    },

    async markCheckpoint(input) {
      const checkpoint: AgentTeamCheckpoint = { ...input, id: newId("team-checkpoint") }
      const key = input.childRunId ?? `run:${input.runId}`
      state.checkpoints.set(key, [...(state.checkpoints.get(key) ?? []), checkpoint])
      if (input.childRunId) {
        const child = state.children.get(input.childRunId)
        if (child) state.children.set(child.id, apply(child, checkpointChildPatch(checkpoint)))
      }
      return { ...checkpoint }
    },
    async getLatestCheckpoint(childRunId) {
      const rows = [...(state.checkpoints.get(childRunId) ?? [])].sort(
        (a, b) => a.createdAt - b.createdAt
      )
      const latest = rows[rows.length - 1]
      return latest ? { ...latest } : undefined
    },

    async createSteeringReceipt(receipt) {
      if (state.steering.has(receipt.id)) {
        throw new Error(`Steering receipt already exists: ${receipt.id}`)
      }
      state.steering.set(receipt.id, { ...receipt })
      const child = state.children.get(receipt.childRunId)
      if (child)
        state.children.set(child.id, apply(child, steeringQueuedChildPatch(child, receipt)))
      return { ...receipt }
    },
    async updateSteeringReceipt(receiptId, status, at, reason) {
      const receipt = state.steering.get(receiptId)
      if (!receipt) return false
      state.steering.set(receiptId, apply(receipt, steeringReceiptPatch(status, at, reason)))
      const child = state.children.get(receipt.childRunId)
      const childPatch = child ? steeringResolvedChildPatch(child, status, at) : undefined
      if (child && childPatch) state.children.set(child.id, apply(child, childPatch))
      return true
    },
    async listPendingSteering(childRunId) {
      return pendingSteering(
        [...state.steering.values()].filter((row) => row.childRunId === childRunId)
      ).map((row) => ({ ...row }))
    },
    async listSteeringReceipts(runId) {
      return [...state.steering.values()]
        .filter((row) => row.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ ...row }))
    },

    async putEvidence(evidence, content) {
      const object = content
        ? await createContentObject(content.data, content.mimeType, evidence.createdAt)
        : undefined
      const row = { ...evidence, ...(object ? { contentHash: object.hash } : {}) }
      if (object) state.content.set(object.hash, object)
      state.evidence.set(row.id, row)
      return { ...row }
    },
    async getEvidence(ids) {
      return ids.map((id) => {
        const row = state.evidence.get(id)
        return row ? { ...row } : undefined
      })
    },
    async listEvidence(runId, scope) {
      return [...state.evidence.values()]
        .filter((row) => evidenceInScope(row, runId, scope))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ ...row }))
    },

    async putDecision(decision) {
      assertDecisionBoundary(decision)
      state.decisions.set(decision.id, { ...decision })
    },
    async getDecision(id) {
      const row = state.decisions.get(id)
      return row ? { ...row } : undefined
    },
    async listDecisions(runId) {
      return sortDecisions([...state.decisions.values()].filter((row) => row.runId === runId)).map(
        (row) => ({ ...row })
      )
    },

    async getContent(hash) {
      const object = await verifiedContent(state.content.get(hash), hash)
      // Callers get their own bytes; the stored object stays as written.
      return object ? { ...object, data: new Uint8Array(object.data) } : undefined
    },
  }

  function appendEvent(
    input: Parameters<TeamRunStore<TConstraints>["appendTrajectory"]>[0],
    contentHash?: string
  ): AgentTeamTrajectoryEvent {
    const events = state.trajectory.get(input.runId) ?? []
    const event = nextTrajectoryEvent(events[events.length - 1]?.sequence, input, contentHash)
    state.trajectory.set(input.runId, [...events, event])
    if (input.childRunId) {
      const child = state.children.get(input.childRunId)
      if (child) state.children.set(child.id, apply(child, trajectoryChildPatch(event)))
    }
    return { ...event }
  }

  const tx: TeamRunStore<TConstraints> = {
    ...ops,
    // Already inside the unit: a nested block simply runs in it.
    atomically: (operation) => operation(tx),
  }

  const outer = Object.fromEntries(
    Object.entries(ops).map(([name, operation]) => [
      name,
      (...args: unknown[]) =>
        queued(() => (operation as (...a: unknown[]) => Promise<unknown>)(...args)),
    ])
  ) as Omit<TeamRunStore<TConstraints>, "atomically">

  return {
    ...outer,
    atomically: (operation) =>
      queued(async () => {
        const saved = snapshot(state)
        try {
          return await operation(tx)
        } catch (error) {
          state = saved
          throw error
        }
      }),
  }
}
