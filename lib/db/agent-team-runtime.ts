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
import { getDb } from "./schema"

const INTERRUPTED_EXECUTION_STATUSES = new Set<AgentTeamRunStatus>([
  "running",
  "pausing",
  "recovering",
])

function id(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${suffix}`
}

function assertRunBoundary(run: AgentTeamRunRecord): void {
  if (!run.id || !run.teamId || !run.objective.trim()) {
    throw new Error("Durable AgentTeam run requires id, teamId, and objective")
  }
  if (!Number.isInteger(run.decisionVersion) || run.decisionVersion < 0) {
    throw new Error("Durable AgentTeam run decisionVersion must be a non-negative integer")
  }
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

export async function listAgentTeamRuns(teamId?: string): Promise<AgentTeamRunRecord[]> {
  const rows = teamId
    ? await getDb().agentTeamRuns.where("teamId").equals(teamId).toArray()
    : await getDb().agentTeamRuns.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listAgentTeamRecoveryCandidates(): Promise<AgentTeamRunRecord[]> {
  return (
    (await getDb().agentTeamRuns.toArray())
      // Queued runs retain their queue position, while pause, sleep, and input
      // gates are deliberate operator states. Only execution that could have
      // been interrupted by process loss needs checkpoint recovery.
      .filter((run) => INTERRUPTED_EXECUTION_STATUSES.has(run.status))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.queueEnteredAt ?? a.createdAt) - (b.queueEnteredAt ?? b.createdAt)
      )
  )
}

export async function createAgentTeamChildRun(child: AgentTeamChildRun): Promise<void> {
  if (!child.id || !child.runId || !child.teammateId || !child.taskId || !child.repositoryId) {
    throw new Error("Durable AgentTeam child requires run, teammate, task, and repository")
  }
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
  return rows
    .filter((row) => row.taskId === taskId && row.teammateId === teammateId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export async function updateAgentTeamChildRun(
  id: string,
  patch: Partial<Omit<AgentTeamChildRun, "id" | "runId" | "teamId" | "createdAt">>
): Promise<boolean> {
  return (await getDb().agentTeamChildRuns.update(id, patch)) > 0
}

export type AppendTrajectoryInput = Omit<AgentTeamTrajectoryEvent, "id" | "sequence">

export async function appendAgentTeamTrajectory(
  input: AppendTrajectoryInput
): Promise<AgentTeamTrajectoryEvent> {
  const db = getDb()
  return db.transaction("rw", db.agentTeamTrajectory, db.agentTeamChildRuns, async () => {
    const last = await db.agentTeamTrajectory
      .where("[runId+sequence]")
      .between([input.runId, -Infinity], [input.runId, Infinity])
      .last()
    const sequence = (last?.sequence ?? 0) + 1
    const event: AgentTeamTrajectoryEvent = {
      ...input,
      id: `${input.runId}:${sequence}`,
      sequence,
    }
    await db.agentTeamTrajectory.add(event)
    if (input.childRunId) {
      await db.agentTeamChildRuns.update(input.childRunId, {
        lastTrajectorySequence: sequence,
        updatedAt: input.createdAt,
      })
    }
    return event
  })
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

export type MarkCheckpointInput = Omit<AgentTeamCheckpoint, "id">

export async function markAgentTeamCheckpoint(
  input: MarkCheckpointInput
): Promise<AgentTeamCheckpoint> {
  const db = getDb()
  const checkpoint: AgentTeamCheckpoint = { ...input, id: id("team-checkpoint") }
  await db.transaction("rw", db.agentTeamCheckpoints, db.agentTeamChildRuns, async () => {
    await db.agentTeamCheckpoints.add(checkpoint)
    if (input.childRunId) {
      await db.agentTeamChildRuns.update(input.childRunId, {
        lastCheckpointId: checkpoint.id,
        lastTrajectorySequence: input.trajectorySequence,
        updatedAt: input.createdAt,
      })
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
  if (decision.status === "constraint" && !decision.immutable) {
    throw new Error("User constraints must be immutable")
  }
  await getDb().agentTeamDecisions.put(decision)
}

export async function listAgentTeamDecisions(runId: string): Promise<AgentTeamDecision[]> {
  return getDb()
    .agentTeamDecisions.where("[runId+version]")
    .between([runId, -Infinity], [runId, Infinity])
    .toArray()
}

export async function createAgentTeamSteeringReceipt(
  receipt: AgentTeamSteeringReceipt
): Promise<AgentTeamSteeringReceipt> {
  const db = getDb()
  await db.transaction("rw", db.agentTeamSteeringReceipts, db.agentTeamChildRuns, async () => {
    await db.agentTeamSteeringReceipts.add(receipt)
    const child = await db.agentTeamChildRuns.get(receipt.childRunId)
    if (child) {
      await db.agentTeamChildRuns.update(child.id, {
        pendingSteeringCount: (child.pendingSteeringCount ?? 0) + 1,
        updatedAt: receipt.updatedAt,
      })
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
    const patch: Partial<AgentTeamSteeringReceipt> = {
      status,
      updatedAt: at,
      ...(reason ? { reason } : {}),
      ...(status === "delivered" ? { deliveredAt: at } : {}),
      ...(status === "applied" ? { appliedAt: at } : {}),
    }
    await db.agentTeamSteeringReceipts.update(receiptId, patch)
    if (status === "applied" || status === "rejected") {
      const child = await db.agentTeamChildRuns.get(receipt.childRunId)
      if (child) {
        await db.agentTeamChildRuns.update(child.id, {
          pendingSteeringCount: Math.max(0, (child.pendingSteeringCount ?? 1) - 1),
          updatedAt: at,
        })
      }
    }
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
  return rows
    .filter((row) => row.status === "queued" || row.status === "delivered")
    .sort((a, b) => a.createdAt - b.createdAt)
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

export async function listAgentTeamEvidence(runId: string): Promise<AgentTeamEvidence[]> {
  return getDb()
    .agentTeamEvidence.where("[runId+createdAt]")
    .between([runId, -Infinity], [runId, Infinity])
    .toArray()
}

export async function getAgentTeamContent(
  hash: string
): Promise<AgentTeamContentObject | undefined> {
  return getDb().agentTeamContentObjects.get(hash)
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
    const resourceUsage = children.reduce<NonNullable<AgentTeamRunRecord["resourceUsage"]>>(
      (total, child) => ({
        promptTokens: total.promptTokens + child.resourceUsage.promptTokens,
        completionTokens: total.completionTokens + child.resourceUsage.completionTokens,
        totalTokens: total.totalTokens + child.resourceUsage.totalTokens,
        ...(total.costUsd !== undefined || child.resourceUsage.costUsd !== undefined
          ? { costUsd: (total.costUsd ?? 0) + (child.resourceUsage.costUsd ?? 0) }
          : {}),
        wallTimeMs: Math.max(total.wallTimeMs, child.resourceUsage.wallTimeMs),
        toolTimeMs: total.toolTimeMs + child.resourceUsage.toolTimeMs,
        attempts: total.attempts + child.resourceUsage.attempts,
        failures: total.failures + child.resourceUsage.failures,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        wallTimeMs: 0,
        toolTimeMs: 0,
        attempts: 0,
        failures: 0,
      }
    )
    await db.agentTeamRuns.update(runId, { resourceUsage, updatedAt })
    return resourceUsage
  })
}

async function sha256(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for AgentTeam content")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource)
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

export async function putAgentTeamContent(
  content: string | Uint8Array,
  mimeType: string,
  createdAt = Date.now()
): Promise<AgentTeamContentObject> {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content
  const hash = await sha256(data)
  const row: AgentTeamContentObject = {
    hash,
    mimeType,
    byteLength: data.byteLength,
    data,
    createdAt,
  }
  await getDb().agentTeamContentObjects.put(row)
  return row
}

export async function purgeAgentTeamRun(runId: string): Promise<void> {
  const db = getDb()
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
    ],
    async () => {
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
    }
  )
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
  const hashes = (await db.agentTeamContentObjects.toCollection().primaryKeys()) as string[]
  const orphaned = hashes.filter((hash) => !liveHashes.has(hash))
  if (orphaned.length > 0) await db.agentTeamContentObjects.bulkDelete(orphaned)
}

export async function purgeAgentTeam(teamId: string): Promise<void> {
  const runIds = (await listAgentTeamRuns(teamId)).map((run) => run.id)
  for (const runId of runIds) await purgeAgentTeamRun(runId)
}
