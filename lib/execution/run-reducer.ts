import type {
  ExecutionRun,
  ExecutionRunStatus,
  RunControlAction,
  RunEvent,
  RunProjectionSnapshot,
  RunStepSnapshot,
  RunStepStatus,
} from "@/types/execution/run"

const TERMINAL = new Set<ExecutionRunStatus>(["completed", "failed", "cancelled"])
const RECENT_STEP_LIMIT = 3

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function allowedActions(
  status: ExecutionRunStatus,
  kind: ExecutionRun["kind"]
): RunControlAction[] {
  if (TERMINAL.has(status)) return ["open_details"]
  switch (status) {
    case "paused":
      return kind === "workflow" ? ["resume", "stop", "open_details"] : ["stop", "open_details"]
    case "recovery_required":
      return ["stop", "open_details"]
    case "waiting":
      return ["approve", "deny", "stop", "open_details"]
    default:
      return ["stop", "open_details"]
  }
}

function eventStatus(type: RunEvent["type"]): ExecutionRunStatus | undefined {
  switch (type) {
    case "run.started":
    case "run.resumed":
    case "interrupt.resolved":
      return "running"
    case "run.waiting":
    case "interrupt.requested":
      return "waiting"
    case "run.paused":
    case "interrupt.expired":
      return "paused"
    case "run.recovery_required":
      return "recovery_required"
    case "run.completed":
      return "completed"
    case "run.failed":
      return "failed"
    case "run.cancelled":
      return "cancelled"
    default:
      return undefined
  }
}

function stepStatus(type: RunEvent["type"]): RunStepStatus | undefined {
  switch (type) {
    case "step.added":
      return "pending"
    case "step.started":
      return "in_progress"
    case "step.completed":
      return "completed"
    case "step.failed":
      return "failed"
    case "step.skipped":
      return "skipped"
    default:
      return undefined
  }
}

/** Fold a semantic event journal into the compact, platform-neutral IM snapshot. */
export function reduceRunEvents(
  run: ExecutionRun,
  inputEvents: readonly RunEvent[]
): RunProjectionSnapshot {
  const eventsBySeq = new Map<number, RunEvent>()
  for (const event of inputEvents) {
    if (event.runId !== run.id || event.seq <= run.currentRevision) continue
    if (!eventsBySeq.has(event.seq)) eventsBySeq.set(event.seq, event)
  }
  const candidates = [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq)
  const events: RunEvent[] = []
  let expectedSeq = run.currentRevision + 1
  for (const event of candidates) {
    if (event.seq > expectedSeq) break
    if (event.seq === expectedSeq) {
      events.push(event)
      expectedSeq += 1
    }
  }
  const steps = new Map<string, RunStepSnapshot>()
  let status = run.status
  let revision = run.currentRevision
  let updatedAt = run.updatedAt
  let endedAt = run.endedAt
  let planVersion: number | undefined
  let summary: string | undefined
  let error: string | undefined
  let waitingReason: string | undefined
  let pendingInterrupt: RunProjectionSnapshot["pendingInterrupt"]
  const artifacts: RunProjectionSnapshot["artifacts"] = []

  for (const event of events) {
    revision = event.seq
    updatedAt = Math.max(updatedAt, event.ts)
    const nextStatus = eventStatus(event.type)
    if (nextStatus && !TERMINAL.has(status)) {
      status = nextStatus
      if (TERMINAL.has(nextStatus)) endedAt = event.ts
    }

    if (event.type === "plan.created" || event.type === "plan.revised") {
      planVersion = numberValue(event.payload.version) ?? (planVersion ?? 0) + 1
      const incoming = Array.isArray(event.payload.steps) ? event.payload.steps : []
      const revisedSteps = new Map<string, RunStepSnapshot>()
      for (const raw of incoming) {
        if (!raw || typeof raw !== "object") continue
        const row = raw as Record<string, unknown>
        const id = stringValue(row.id)
        const title = stringValue(row.title)
        if (!id || !title) continue
        const prior = steps.get(id)
        revisedSteps.set(id, {
          ...prior,
          id,
          title,
          status:
            (stringValue(row.status) as RunStepStatus | undefined) ?? prior?.status ?? "pending",
        })
      }
      steps.clear()
      for (const [id, step] of revisedSteps) steps.set(id, step)
    }

    const nextStepStatus = stepStatus(event.type)
    const stepId = stringValue(event.payload.stepId)
    if (nextStepStatus && stepId) {
      const prior = steps.get(stepId)
      const title = stringValue(event.payload.title) ?? prior?.title ?? stepId
      steps.set(stepId, {
        ...prior,
        id: stepId,
        title,
        status: nextStepStatus,
        ...(event.type === "step.started" ? { startedAt: event.ts } : {}),
        ...(nextStepStatus === "completed" || nextStepStatus === "failed"
          ? { completedAt: event.ts }
          : {}),
        ...(stringValue(event.payload.summary)
          ? { summary: stringValue(event.payload.summary) }
          : {}),
        ...(stringValue(event.payload.detail) ? { detail: stringValue(event.payload.detail) } : {}),
      })
    }

    if (event.type === "run.completed") summary = stringValue(event.payload.summary) ?? summary
    if (event.type === "run.failed") error = stringValue(event.payload.error) ?? "Run failed"
    if (
      event.type === "run.waiting" ||
      event.type === "run.recovery_required" ||
      event.type === "interrupt.requested"
    ) {
      waitingReason = stringValue(event.payload.reason) ?? stringValue(event.payload.title)
    }
    if (event.type === "interrupt.requested") {
      const id = stringValue(event.payload.interruptId)
      const title = stringValue(event.payload.title)
      if (id && title) {
        pendingInterrupt = {
          id,
          title,
          ...(numberValue(event.payload.expiresAt) !== undefined
            ? { expiresAt: numberValue(event.payload.expiresAt) }
            : {}),
        }
      }
    }
    if (event.type === "interrupt.resolved" || event.type === "interrupt.expired") {
      pendingInterrupt = undefined
      waitingReason = undefined
    }
    if (event.type === "artifact.created") {
      const id = stringValue(event.payload.artifactId)
      const title = stringValue(event.payload.title)
      if (id && title) {
        artifacts.push({
          id,
          title,
          ...(stringValue(event.payload.url) ? { url: stringValue(event.payload.url) } : {}),
          ...(stringValue(event.payload.mimeType)
            ? { mimeType: stringValue(event.payload.mimeType) }
            : {}),
        })
      }
    }
  }

  const allSteps = [...steps.values()]
  const completed = allSteps.filter((step) => step.status === "completed").length
  const trustworthy = run.kind === "workflow"
  const progress = {
    completed,
    total: allSteps.length,
    ...(trustworthy && allSteps.length > 0 ? { ratio: completed / allSteps.length } : {}),
    trustworthy,
  }
  const activeSteps = allSteps.filter((step) => step.status === "in_progress")
  const recentSteps = allSteps
    .filter((step) => ["completed", "failed", "skipped"].includes(step.status))
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, RECENT_STEP_LIMIT)
  const pendingSteps = allSteps.filter((step) => step.status === "pending")

  return {
    runId: run.id,
    kind: run.kind,
    title: run.title,
    status,
    revision,
    startedAt: run.startedAt,
    updatedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(planVersion !== undefined ? { planVersion } : {}),
    progress,
    activeSteps,
    recentSteps,
    pendingSteps,
    pendingStepCount: pendingSteps.length,
    elapsedMs: Math.max(0, (endedAt ?? updatedAt) - run.startedAt),
    detailsUrl: `/agent-runs/${encodeURIComponent(run.id)}`,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(pendingInterrupt ? { pendingInterrupt } : {}),
    artifacts,
    allowedActions: allowedActions(status, run.kind),
  }
}
