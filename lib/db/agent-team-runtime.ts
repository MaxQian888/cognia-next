import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamContentObject,
  AgentTeamDecision,
  AgentTeamDeliveryGraph,
  AgentTeamDeliveryNode,
  AgentTeamEvidence,
  AgentTeamRetrospective,
  AgentTeamRunRecord,
  AgentTeamRunStatus,
  AgentTeamSteeringReceipt,
  AgentTeamSteeringStatus,
  AgentTeamTrajectoryEvent,
} from "@/types/agent/agent-team-runtime"
import type { AgentTeamExecutionConstraints } from "@/types/agent/agent-team-runtime"
import { createContentObject, verifiedContent } from "@cognia/agent-orchestration/content"
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
  type AppendTrajectoryInput,
  type ClaimDispatchLeaseInput,
  type EvidenceScope,
  type MarkCheckpointInput,
} from "@cognia/agent-orchestration/rules"
import type { TeamRunStore } from "@cognia/agent-orchestration/store"
import { sumChildUsage } from "@cognia/agent-orchestration/usage"
import { getDb } from "./schema"

// The persistence rules (compare-and-set, dispatch lease, monotonic trajectory,
// checkpoint and steering bookkeeping, recovery order) are defined once in
// `@cognia/agent-orchestration/rules` (ADR-0217). This module applies them
// inside Dexie transactions and exposes the result as a `TeamRunStore`.
export type { AppendTrajectoryInput, MarkCheckpointInput }
export type ClaimAgentTeamDispatchLeaseInput = ClaimDispatchLeaseInput

/** Content objects are built by the orchestration package (one hash definition). */
const makeAgentTeamContent = createContentObject

function id(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

export async function createAgentTeamRun(run: AgentTeamRunRecord): Promise<void> {
  assertRunBoundary(run)
  await getDb().agentTeamRuns.add(run)
}

export async function getAgentTeamRun(id: string): Promise<AgentTeamRunRecord | undefined> {
  return getDb().agentTeamRuns.get(id)
}

export async function updateAgentTeamRun(
  id: string,
  patch: Partial<Omit<AgentTeamRunRecord, "id" | "teamId" | "createdAt">>
): Promise<boolean> {
  return (await getDb().agentTeamRuns.update(id, patch)) > 0
}

/** Atomically update a run only while its durable control state is unchanged. */
export async function updateAgentTeamRunIfCurrent(
  id: string,
  expected: Pick<AgentTeamRunRecord, "status" | "updatedAt">,
  patch: Partial<Omit<AgentTeamRunRecord, "id" | "teamId" | "createdAt">>
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamRuns, async () => {
    const run = await db.agentTeamRuns.get(id)
    if (!matchesControlState(run, expected)) return false
    return (await db.agentTeamRuns.update(id, patch)) > 0
  })
}

export async function listAgentTeamRuns(teamId?: string): Promise<AgentTeamRunRecord[]> {
  const rows = teamId
    ? await getDb().agentTeamRuns.where("teamId").equals(teamId).toArray()
    : await getDb().agentTeamRuns.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listAgentTeamRecoveryCandidates(): Promise<AgentTeamRunRecord[]> {
  return selectRecoveryCandidates(await getDb().agentTeamRuns.toArray())
}

export async function createAgentTeamChildRun(child: AgentTeamChildRun): Promise<void> {
  assertChildBoundary(child)
  await getDb().agentTeamChildRuns.add(child)
}

export async function getAgentTeamChildRun(id: string): Promise<AgentTeamChildRun | undefined> {
  return getDb().agentTeamChildRuns.get(id)
}

export async function listAgentTeamChildRuns(runId: string): Promise<AgentTeamChildRun[]> {
  const rows = await getDb().agentTeamChildRuns.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function findLatestAgentTeamChildRun(
  runId: string,
  taskId: string,
  teammateId: string
): Promise<AgentTeamChildRun | undefined> {
  const rows = await getDb().agentTeamChildRuns.where("runId").equals(runId).toArray()
  return latestChildFor(rows, taskId, teammateId)
}

export async function updateAgentTeamChildRun(
  id: string,
  patch: Partial<Omit<AgentTeamChildRun, "id" | "runId" | "teamId" | "createdAt">>
): Promise<boolean> {
  return (await getDb().agentTeamChildRuns.update(id, patch)) > 0
}

/** Atomically update a child only while its durable control state is unchanged. */
export async function updateAgentTeamChildRunIfCurrent(
  id: string,
  expected: Pick<AgentTeamChildRun, "status" | "updatedAt">,
  patch: Partial<Omit<AgentTeamChildRun, "id" | "runId" | "teamId" | "createdAt">>
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamChildRuns, async () => {
    const child = await db.agentTeamChildRuns.get(id)
    if (!matchesControlState(child, expected)) return false
    return (await db.agentTeamChildRuns.update(id, patch)) > 0
  })
}

/**
 * Claim the existing child row as the remote dispatch lease authority. The CAS
 * permits idempotent replay by the same lease and rejects a competing lease
 * until the old claim expires.
 */
export async function claimAgentTeamDispatchLease(
  input: ClaimAgentTeamDispatchLeaseInput
): Promise<AgentTeamChildRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamChildRuns, async () => {
    const child = await db.agentTeamChildRuns.get(input.childRunId)
    if (!child) return undefined
    const patch = dispatchLeaseClaimPatch(child, input)
    if (!patch) return undefined
    await db.agentTeamChildRuns.update(child.id, patch)
    return { ...child, ...patch }
  })
}

export async function renewAgentTeamDispatchLease(
  childRunId: string,
  expectedLeaseId: string,
  now: number,
  ttlMs?: number
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamChildRuns, async () => {
    const child = await db.agentTeamChildRuns.get(childRunId)
    const patch = dispatchLeaseRenewPatch(child, expectedLeaseId, now, ttlMs)
    if (!patch) return false
    return (await db.agentTeamChildRuns.update(childRunId, patch)) > 0
  })
}

export async function settleAgentTeamDispatchLease(
  childRunId: string,
  expectedLeaseId: string,
  now: number
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamChildRuns, async () => {
    const child = await db.agentTeamChildRuns.get(childRunId)
    const patch = dispatchLeaseSettlePatch(child, expectedLeaseId, now)
    if (!patch) return false
    return (await db.agentTeamChildRuns.update(childRunId, patch)) > 0
  })
}

/** Sequential event CAS used by the remote adapter to reject duplicate replay. */
export async function advanceAgentTeamRemoteEvent(
  childRunId: string,
  expectedPreviousEventId: string | undefined,
  eventId: string,
  now: number,
  envelope?: { runId: string; event: Record<string, unknown> }
): Promise<boolean> {
  const db = getDb()
  const object = envelope
    ? await makeAgentTeamContent(JSON.stringify(envelope.event), "application/json", now)
    : undefined
  return db.transaction(
    "rw",
    [db.agentTeamChildRuns, db.agentTeamTrajectory, db.agentTeamContentObjects],
    async () => {
      const child = await db.agentTeamChildRuns.get(childRunId)
      if (!canAdvanceRemoteEvent(child, expectedPreviousEventId)) return false
      if (envelope && object) {
        if (child.runId !== envelope.runId) throw new Error("Remote event belongs to another run")
        await db.agentTeamContentObjects.put(object)
        await appendAgentTeamTrajectory({
          runId: envelope.runId,
          childRunId,
          kind: "remote_event",
          correlationId: eventId,
          contentHash: object.hash,
          createdAt: now,
        })
      }
      return (
        (await db.agentTeamChildRuns.update(childRunId, {
          lastRemoteEventId: eventId,
          updatedAt: now,
        })) > 0
      )
    }
  )
}

export async function appendAgentTeamTrajectory(
  input: AppendTrajectoryInput,
  content?: { data: string | Uint8Array; mimeType: string }
): Promise<AgentTeamTrajectoryEvent> {
  const db = getDb()
  const object = content
    ? await makeAgentTeamContent(content.data, content.mimeType, input.createdAt)
    : undefined
  return db.transaction(
    "rw",
    [db.agentTeamTrajectory, db.agentTeamChildRuns, db.agentTeamContentObjects],
    async () => {
      if (object) await db.agentTeamContentObjects.put(object)
      const last = await db.agentTeamTrajectory
        .where("[runId+sequence]")
        .between([input.runId, -Infinity], [input.runId, Infinity])
        .last()
      const event = nextTrajectoryEvent(last?.sequence, input, object?.hash)
      await db.agentTeamTrajectory.add(event)
      if (input.childRunId) {
        await db.agentTeamChildRuns.update(input.childRunId, trajectoryChildPatch(event))
      }
      return event
    }
  )
}

export async function listAgentTeamTrajectory(
  runId: string,
  afterSequence = 0
): Promise<AgentTeamTrajectoryEvent[]> {
  return getDb()
    .agentTeamTrajectory.where("[runId+sequence]")
    .between([runId, afterSequence], [runId, Infinity], false, true)
    .toArray()
}

export async function markAgentTeamCheckpoint(
  input: MarkCheckpointInput
): Promise<AgentTeamCheckpoint> {
  const db = getDb()
  const checkpoint: AgentTeamCheckpoint = { ...input, id: id("team-checkpoint") }
  await db.transaction("rw", db.agentTeamCheckpoints, db.agentTeamChildRuns, async () => {
    await db.agentTeamCheckpoints.add(checkpoint)
    if (input.childRunId) {
      await db.agentTeamChildRuns.update(input.childRunId, checkpointChildPatch(checkpoint))
    }
  })
  return checkpoint
}

export async function getLatestAgentTeamCheckpoint(
  childRunId: string
): Promise<AgentTeamCheckpoint | undefined> {
  return getDb()
    .agentTeamCheckpoints.where("[childRunId+createdAt]")
    .between([childRunId, -Infinity], [childRunId, Infinity])
    .last()
}

export async function putAgentTeamDecision(decision: AgentTeamDecision): Promise<void> {
  assertDecisionBoundary(decision)
  await getDb().agentTeamDecisions.put(decision)
}

export async function getAgentTeamDecision(id: string): Promise<AgentTeamDecision | undefined> {
  return getDb().agentTeamDecisions.get(id)
}

export async function listAgentTeamDecisions(runId: string): Promise<AgentTeamDecision[]> {
  return sortDecisions(
    await getDb()
      .agentTeamDecisions.where("[runId+version]")
      .between([runId, -Infinity], [runId, Infinity])
      .toArray()
  )
}

export async function createAgentTeamSteeringReceipt(
  receipt: AgentTeamSteeringReceipt
): Promise<AgentTeamSteeringReceipt> {
  const db = getDb()
  await db.transaction("rw", db.agentTeamSteeringReceipts, db.agentTeamChildRuns, async () => {
    await db.agentTeamSteeringReceipts.add(receipt)
    const child = await db.agentTeamChildRuns.get(receipt.childRunId)
    if (child) {
      await db.agentTeamChildRuns.update(child.id, steeringQueuedChildPatch(child, receipt))
    }
  })
  return receipt
}

export async function updateAgentTeamSteeringReceipt(
  receiptId: string,
  status: AgentTeamSteeringStatus,
  at: number,
  reason?: string
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamSteeringReceipts, db.agentTeamChildRuns, async () => {
    const receipt = await db.agentTeamSteeringReceipts.get(receiptId)
    if (!receipt) return false
    await db.agentTeamSteeringReceipts.update(receiptId, steeringReceiptPatch(status, at, reason))
    const child = await db.agentTeamChildRuns.get(receipt.childRunId)
    const childPatch = child ? steeringResolvedChildPatch(child, status, at) : undefined
    if (child && childPatch) await db.agentTeamChildRuns.update(child.id, childPatch)
    return true
  })
}

export async function listPendingAgentTeamSteering(
  childRunId: string
): Promise<AgentTeamSteeringReceipt[]> {
  const rows = await getDb()
    .agentTeamSteeringReceipts.where("childRunId")
    .equals(childRunId)
    .toArray()
  return pendingSteering(rows)
}

export async function listAgentTeamSteeringReceipts(
  runId: string
): Promise<AgentTeamSteeringReceipt[]> {
  const rows = await getDb().agentTeamSteeringReceipts.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function putAgentTeamEvidence(evidence: AgentTeamEvidence): Promise<void> {
  await getDb().agentTeamEvidence.put(evidence)
}

/** Commit bytes and their durable reference together; GC observes both or neither. */
export async function putAgentTeamEvidenceContent(
  evidence: AgentTeamEvidence,
  content?: string | Uint8Array,
  mimeType = "text/plain"
): Promise<AgentTeamEvidence> {
  const db = getDb()
  const object =
    content === undefined
      ? undefined
      : await makeAgentTeamContent(content, mimeType, evidence.createdAt)
  const row = { ...evidence, ...(object ? { contentHash: object.hash } : {}) }
  await db.transaction("rw", [db.agentTeamEvidence, db.agentTeamContentObjects], async () => {
    if (object) await db.agentTeamContentObjects.put(object)
    await db.agentTeamEvidence.put(row)
  })
  return row
}

export async function listAgentTeamEvidence(
  runId: string,
  scope: EvidenceScope = {}
): Promise<AgentTeamEvidence[]> {
  const table = getDb().agentTeamEvidence
  // Reuse existing indexes so child completion does not scan an entire team's
  // evidence history. Always keep runId in the predicate for scoped queries.
  const rows =
    scope.childRunId !== undefined
      ? table.where("childRunId").equals(scope.childRunId)
      : scope.taskId !== undefined
        ? table.where("taskId").equals(scope.taskId)
        : table.where("[runId+createdAt]").between([runId, -Infinity], [runId, Infinity])
  return rows.filter((item) => evidenceInScope(item, runId, scope)).sortBy("createdAt")
}

/** One entry per id, `undefined` where none exists. */
export async function getAgentTeamEvidence(
  ids: readonly string[]
): Promise<(AgentTeamEvidence | undefined)[]> {
  return getDb().agentTeamEvidence.bulkGet([...ids])
}

export async function getAgentTeamContent(
  hash: string
): Promise<AgentTeamContentObject | undefined> {
  return verifiedContent(await getDb().agentTeamContentObjects.get(hash), hash)
}

export async function putAgentTeamDeliveryGraph(graph: AgentTeamDeliveryGraph): Promise<void> {
  await getDb().agentTeamDeliveryGraphs.put(graph)
}

export async function getAgentTeamDeliveryGraph(
  runId: string
): Promise<AgentTeamDeliveryGraph | undefined> {
  return getDb().agentTeamDeliveryGraphs.where("runId").equals(runId).first()
}

export async function putAgentTeamDeliveryNodes(nodes: AgentTeamDeliveryNode[]): Promise<void> {
  await getDb().agentTeamDeliveryNodes.bulkPut(nodes)
}

export async function listAgentTeamDeliveryNodes(
  graphId: string
): Promise<AgentTeamDeliveryNode[]> {
  return getDb()
    .agentTeamDeliveryNodes.where("[graphId+order]")
    .between([graphId, -Infinity], [graphId, Infinity])
    .toArray()
}

export async function putAgentTeamRetrospective(
  retrospective: AgentTeamRetrospective
): Promise<void> {
  await getDb().agentTeamRetrospectives.put(retrospective)
}

export async function getAgentTeamRetrospective(
  runId: string
): Promise<AgentTeamRetrospective | undefined> {
  return getDb().agentTeamRetrospectives.where("runId").equals(runId).first()
}

export async function aggregateAgentTeamRunUsage(
  runId: string,
  updatedAt = Date.now()
): Promise<AgentTeamRunRecord["resourceUsage"]> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamChildRuns, db.agentTeamRuns, async () => {
    const children = await db.agentTeamChildRuns.where("runId").equals(runId).toArray()
    const resourceUsage = sumChildUsage(children)
    await db.agentTeamRuns.update(runId, { resourceUsage, updatedAt })
    return resourceUsage
  })
}

export async function putAgentTeamContent(
  content: string | Uint8Array,
  mimeType: string,
  createdAt = Date.now()
): Promise<AgentTeamContentObject> {
  const row = await makeAgentTeamContent(content, mimeType, createdAt)
  await getDb().agentTeamContentObjects.put(row)
  return row
}

/** Delete task-owned agent history before removing its only durable reference. */
export async function purgeManagedChildSessions(children: AgentTeamChildRun[]): Promise<void> {
  const sessions = children.flatMap((child) =>
    child.sessionId?.startsWith("cognia-gateway:") ? [child.sessionId] : []
  )
  if (sessions.length === 0) return
  const [{ parseGatewaySessionId }, { agentInvoke }] = await Promise.all([
    import("@/lib/ai/agent/external/config/gateway-task"),
    import("@/lib/ai/agent/external/agent-transport"),
  ])
  const tasks = new Set(sessions.map((sessionId) => parseGatewaySessionId(sessionId)!.taskId))
  for (const taskId of tasks) await agentInvoke("external_agent_delete_gateway_task", { taskId })
}

export async function purgeAgentTeamRun(runId: string): Promise<void> {
  const db = getDb()
  const children = await db.agentTeamChildRuns.where("runId").equals(runId).toArray()
  await purgeManagedChildSessions(children)
  await purgeAgentTeamRunRows(runId, db, new Set(children.map((child) => child.sessionId)))
}

async function purgeAgentTeamRunRows(
  runId: string,
  db: ReturnType<typeof getDb>,
  cleanedSessionLinks: Set<string | undefined>
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.agentTeamRuns,
      db.agentTeamChildRuns,
      db.agentTeamTrajectory,
      db.agentTeamCheckpoints,
      db.agentTeamDecisions,
      db.agentTeamSteeringReceipts,
      db.agentTeamEvidence,
      db.agentTeamDeliveryGraphs,
      db.agentTeamDeliveryNodes,
      db.agentTeamRetrospectives,
      db.agentTeamContentObjects,
    ],
    async () => {
      const [removedTrajectory, removedEvidence, removedRetrospectives] = await Promise.all([
        db.agentTeamTrajectory.where("runId").equals(runId).toArray(),
        db.agentTeamEvidence.where("runId").equals(runId).toArray(),
        db.agentTeamRetrospectives.where("runId").equals(runId).toArray(),
      ])
      const candidateHashes = new Set(
        [...removedTrajectory, ...removedEvidence, ...removedRetrospectives].flatMap((row) =>
          row.contentHash ? [row.contentHash] : []
        )
      )
      const children = await db.agentTeamChildRuns.where("runId").equals(runId).toArray()
      if (
        children.some(
          (child) =>
            child.sessionId?.startsWith("cognia-gateway:") &&
            !cleanedSessionLinks.has(child.sessionId)
        )
      ) {
        throw new Error("Team tasks changed during native cleanup; retry deletion")
      }
      const graphIds = await db.agentTeamDeliveryGraphs.where("runId").equals(runId).primaryKeys()
      await Promise.all([
        db.agentTeamRuns.delete(runId),
        db.agentTeamChildRuns.where("runId").equals(runId).delete(),
        db.agentTeamTrajectory.where("runId").equals(runId).delete(),
        db.agentTeamCheckpoints.where("runId").equals(runId).delete(),
        db.agentTeamDecisions.where("runId").equals(runId).delete(),
        db.agentTeamSteeringReceipts.where("runId").equals(runId).delete(),
        db.agentTeamEvidence.where("runId").equals(runId).delete(),
        db.agentTeamDeliveryGraphs.where("runId").equals(runId).delete(),
        db.agentTeamDeliveryNodes.where("runId").equals(runId).delete(),
        db.agentTeamRetrospectives.where("runId").equals(runId).delete(),
      ])
      if (graphIds.length > 0) {
        await db.agentTeamDeliveryNodes
          .where("graphId")
          .anyOf(graphIds as string[])
          .delete()
      }
      const [trajectory, evidence, retrospectives] = await Promise.all([
        db.agentTeamTrajectory.toArray(),
        db.agentTeamEvidence.toArray(),
        db.agentTeamRetrospectives.toArray(),
      ])
      const liveHashes = new Set<string>([
        ...trajectory.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
        ...evidence.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
        ...retrospectives.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
      ])
      const orphaned = [...candidateHashes].filter((hash) => !liveHashes.has(hash))
      if (orphaned.length > 0) await db.agentTeamContentObjects.bulkDelete(orphaned)
    }
  )
}

export async function purgeAgentTeam(teamId: string): Promise<void> {
  const db = getDb()
  const runIds = (await db.agentTeamRuns.where("teamId").equals(teamId).toArray()).map(
    (run) => run.id
  )
  const children = runIds.length
    ? await db.agentTeamChildRuns.where("runId").anyOf(runIds).toArray()
    : []
  await purgeManagedChildSessions(children)
  const cleanedSessionLinks = new Set(children.map((child) => child.sessionId))
  for (const runId of runIds) await purgeAgentTeamRunRows(runId, db, cleanedSessionLinks)
}

/**
 * Every Dexie table a team run's store operations touch; an atomic block
 * spans all of them so any combination of operations commits together.
 */
function teamRunTables() {
  const db = getDb()
  return [
    db.agentTeamRuns,
    db.agentTeamChildRuns,
    db.agentTeamTrajectory,
    db.agentTeamCheckpoints,
    db.agentTeamSteeringReceipts,
    db.agentTeamEvidence,
    db.agentTeamDecisions,
    db.agentTeamContentObjects,
  ]
}

/**
 * The app's {@link TeamRunStore} (ADR-0217). Operations called inside
 * `atomically` join its Dexie transaction (Dexie scopes nested calls to the
 * active transaction), so `tx` is the store itself. Content hashing awaits
 * WebCrypto, which an IndexedDB transaction cannot stay open across, so an
 * atomic block appends trajectory events without content.
 */
export const dexieTeamRunStore: TeamRunStore<AgentTeamExecutionConstraints> = {
  atomically: (operation) =>
    getDb().transaction("rw", teamRunTables(), () => operation(dexieTeamRunStore)),
  createRun: createAgentTeamRun,
  getRun: getAgentTeamRun,
  updateRun: updateAgentTeamRun,
  updateRunIfCurrent: updateAgentTeamRunIfCurrent,
  listRuns: listAgentTeamRuns,
  listRecoveryCandidates: listAgentTeamRecoveryCandidates,
  createChild: createAgentTeamChildRun,
  getChild: getAgentTeamChildRun,
  listChildren: listAgentTeamChildRuns,
  findLatestChild: findLatestAgentTeamChildRun,
  updateChild: updateAgentTeamChildRun,
  updateChildIfCurrent: updateAgentTeamChildRunIfCurrent,
  claimDispatchLease: claimAgentTeamDispatchLease,
  renewDispatchLease: renewAgentTeamDispatchLease,
  settleDispatchLease: settleAgentTeamDispatchLease,
  advanceRemoteEvent: advanceAgentTeamRemoteEvent,
  appendTrajectory: appendAgentTeamTrajectory,
  listTrajectory: listAgentTeamTrajectory,
  markCheckpoint: markAgentTeamCheckpoint,
  getLatestCheckpoint: getLatestAgentTeamCheckpoint,
  createSteeringReceipt: createAgentTeamSteeringReceipt,
  updateSteeringReceipt: updateAgentTeamSteeringReceipt,
  listPendingSteering: listPendingAgentTeamSteering,
  listSteeringReceipts: listAgentTeamSteeringReceipts,
  putEvidence: (evidence, content) =>
    putAgentTeamEvidenceContent(evidence, content?.data, content?.mimeType),
  getEvidence: getAgentTeamEvidence,
  listEvidence: listAgentTeamEvidence,
  putDecision: putAgentTeamDecision,
  getDecision: getAgentTeamDecision,
  listDecisions: listAgentTeamDecisions,
  getContent: getAgentTeamContent,
}
