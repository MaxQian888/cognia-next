import type {
  ExecutionRun,
  ExecutionRunStatus,
  RunControlAction,
  RunActivityCategory,
  RunActivitySnapshot,
  RunActivityStatus,
  RunEvent,
  RunProjectionSnapshot,
  RunStepSnapshot,
  RunStepStatus,
} from "@/types/execution/run"
import {
  safeActivityTarget,
  safeStableActivityId,
  safeToolActivityMetadata,
  sanitizeActivityLabel,
} from "./run-activity"

const TERMINAL = new Set<ExecutionRunStatus>(["completed", "failed", "cancelled"])
const RECENT_STEP_LIMIT = 3
const ACTIVITY_LIMIT = 12

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function allowedActions(
  status: ExecutionRunStatus,
  kind: ExecutionRun["kind"],
  hasPendingInterrupt: boolean
): RunControlAction[] {
  // No `retry` here, on purpose: the control exists in the vocabulary but the
  // event journal closes on a settled run, so accepting it would need a NEW
  // run linked by `parentRunId` rather than an event on the failed one. Until
  // that lands, offering the button would render a control that always fails.
  // See the note in `run-control.ts`.
  if (TERMINAL.has(status)) return ["open_details"]
  // Kinds with a real steering track: the agent SDK's live input lane
  // (`agent-turn`), the team coordinator's durable receipts (`team`), and a
  // delegation, which fans out to whichever of those is carrying it. Every
  // other kind would render a button whose handler throws.
  const steerable = kind === "agent-turn" || kind === "team" || kind === "delegation"
  // `steer` sits LAST before `open_details` deliberately. Follow-up
  // registrations take the first two verbs, and losing `stop` to make room for
  // a verb that also has a text-prefix route would be a bad trade.
  const withSteer = (actions: RunControlAction[]): RunControlAction[] =>
    steerable ? [...actions.slice(0, -1), "steer", "open_details"] : actions
  switch (status) {
    case "paused":
      // `team` joined this list once a durable AgentTeam run got a control
      // handler that can actually pause and resume it. Before that the kind
      // was routed to the workflow handler, which only knows how to cancel —
      // so offering resume would have been a button that always failed.
      return kind === "plan" ||
        kind === "goal" ||
        kind === "agent-turn" ||
        kind === "team" ||
        kind === "delegation"
        ? ["resume", "stop", "open_details"]
        : ["stop", "open_details"]
    case "recovery_required":
      return ["stop", "open_details"]
    case "waiting":
      return hasPendingInterrupt
        ? ["approve", "deny", "stop", "open_details"]
        : withSteer(["stop", "open_details"])
    default:
      return withSteer(
        kind === "plan" || kind === "goal" || kind === "team" || kind === "delegation"
          ? ["pause", "stop", "open_details"]
          : ["stop", "open_details"]
      )
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

function activityStatus(type: RunEvent["type"]): RunActivityStatus | undefined {
  switch (type) {
    case "step.added":
      return "pending"
    case "step.started":
    case "step.progress":
    case "tool.started":
      return "running"
    case "step.completed":
    case "tool.completed":
    case "artifact.created":
    case "milestone.created":
    case "interrupt.resolved":
      return "completed"
    case "step.failed":
    case "tool.failed":
    case "run.failed":
    case "interrupt.expired":
      return "failed"
    case "step.skipped":
      return "skipped"
    case "run.waiting":
    case "run.paused":
    case "run.recovery_required":
    case "interrupt.requested":
      return "blocked"
    default:
      return undefined
  }
}

const LIFECYCLE_LABELS: Partial<Record<RunEvent["type"], string>> = {
  "run.started": "Run started",
  "run.waiting": "Waiting for review",
  "run.paused": "Run paused",
  "run.resumed": "Run resumed",
  "run.recovery_required": "Recovery required",
  "run.degraded": "Presentation degraded",
  "run.completed": "Run completed",
  "run.failed": "Run failed",
  "run.cancelled": "Run cancelled",
}

function activityCategory(value: unknown, fallback: RunActivityCategory): RunActivityCategory {
  const allowed = new Set<RunActivityCategory>([
    "search",
    "read",
    "write",
    "command",
    "integration",
    "skill",
    "artifact",
    "approval",
    "status",
  ])
  return typeof value === "string" && allowed.has(value as RunActivityCategory)
    ? (value as RunActivityCategory)
    : fallback
}

function upsertActivity(activities: Map<string, RunActivitySnapshot>, event: RunEvent): void {
  if (event.visibility === "private") return
  if (event.type === "run.resumed" || event.type === "interrupt.resolved") {
    for (const [id, activity] of activities) {
      if (activity.kind === "lifecycle" && activity.status === "blocked") {
        activities.set(id, { ...activity, status: "completed", endedAt: event.ts })
      }
    }
  }
  if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    const terminalStatus: RunActivityStatus =
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.failed"
          ? "failed"
          : "skipped"
    for (const [id, activity] of activities) {
      if (
        activity.status === "pending" ||
        activity.status === "running" ||
        activity.status === "blocked"
      ) {
        activities.set(id, { ...activity, status: terminalStatus, endedAt: event.ts })
      }
    }
  }
  const status = activityStatus(event.type)

  if (event.type.startsWith("tool.") && status) {
    const toolCallId = stringValue(event.payload.toolCallId)
    if (!toolCallId) return
    const id = `tool:${safeStableActivityId(toolCallId)}`
    const prior = activities.get(id)
    const toolName = stringValue(event.payload.toolName) ?? prior?.label ?? "Tool"
    const metadata = safeToolActivityMetadata(toolName)
    activities.set(id, {
      id,
      kind: "tool",
      category: activityCategory(event.payload.category, metadata.category),
      status,
      label: sanitizeActivityLabel(toolName, "Tool"),
      ...((safeActivityTarget(event.payload.target) ?? prior?.target)
        ? { target: safeActivityTarget(event.payload.target) ?? prior?.target }
        : {}),
      startedAt: prior?.kind === "tool" ? prior.startedAt : event.ts,
      ...(status === "completed" || status === "failed" ? { endedAt: event.ts } : {}),
    })
    return
  }

  if (event.type.startsWith("step.") && status) {
    const stepId = stringValue(event.payload.stepId)
    if (!stepId) return
    const id = stepId.startsWith("tool:")
      ? `tool:${safeStableActivityId(stepId.slice("tool:".length))}`
      : `step:${safeStableActivityId(stepId)}`
    const prior = activities.get(id)
    if (prior?.kind === "tool") return
    activities.set(id, {
      id,
      kind: "step",
      category: activityCategory(event.payload.category, "status"),
      status,
      label:
        event.payload.safeTitle === true
          ? sanitizeActivityLabel(event.payload.title, prior?.label ?? "Step")
          : (prior?.label ?? "Step"),
      ...((safeActivityTarget(event.payload.target) ?? prior?.target)
        ? { target: safeActivityTarget(event.payload.target) ?? prior?.target }
        : {}),
      startedAt: prior?.startedAt ?? event.ts,
      ...(status === "completed" || status === "failed" || status === "skipped"
        ? { endedAt: event.ts }
        : {}),
    })
    return
  }

  if (event.type === "artifact.created") {
    const artifactId = stringValue(event.payload.artifactId)
    if (!artifactId) return
    const label =
      event.payload.safeTitle === true
        ? sanitizeActivityLabel(event.payload.title, "Artifact created")
        : "Artifact created"
    const id = `artifact:${safeStableActivityId(artifactId)}`
    activities.set(id, {
      id,
      kind: "artifact",
      category: "artifact",
      status: "completed",
      label,
      startedAt: event.ts,
      endedAt: event.ts,
    })
    return
  }

  if (event.type.startsWith("interrupt.") && status) {
    const interruptId = stringValue(event.payload.interruptId)
    if (!interruptId) return
    const id = `approval:${safeStableActivityId(interruptId)}`
    const prior = activities.get(id)
    activities.set(id, {
      id,
      kind: "approval",
      category: "approval",
      status,
      label:
        event.payload.safeTitle === true
          ? sanitizeActivityLabel(event.payload.title, prior?.label ?? "Approval required")
          : (prior?.label ?? "Approval required"),
      startedAt: prior?.startedAt ?? event.ts,
      ...(status === "completed" || status === "failed" ? { endedAt: event.ts } : {}),
    })
    return
  }

  const lifecycleLabel = LIFECYCLE_LABELS[event.type]
  if (lifecycleLabel) {
    const lifecycleStatus: RunActivityStatus =
      event.type === "run.failed"
        ? "failed"
        : event.type === "run.waiting" ||
            event.type === "run.paused" ||
            event.type === "run.recovery_required"
          ? "blocked"
          : "completed"
    const id = `lifecycle:${safeStableActivityId(event.id)}`
    activities.set(id, {
      id,
      kind: "lifecycle",
      category: "status",
      status: lifecycleStatus,
      label: lifecycleLabel,
      startedAt: event.ts,
      ...(lifecycleStatus === "completed" || lifecycleStatus === "failed"
        ? { endedAt: event.ts }
        : {}),
    })
  }
}

function rollingActivities(activities: Map<string, RunActivitySnapshot>): {
  activities: RunActivitySnapshot[]
  activityCount: number
  omittedActivityCount: number
} {
  const all = [...activities.values()]
  const active = all
    .filter((activity) => ["pending", "running", "blocked"].includes(activity.status))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, ACTIVITY_LIMIT)
  const activeIds = new Set(active.map((activity) => activity.id))
  const terminal = all
    .filter((activity) => !activeIds.has(activity.id))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, Math.max(0, ACTIVITY_LIMIT - active.length))
  const visible = [...active, ...terminal].sort((a, b) => a.startedAt - b.startedAt)
  return {
    activities: visible,
    activityCount: all.length,
    omittedActivityCount: Math.max(0, all.length - visible.length),
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
  const activities = new Map<string, RunActivitySnapshot>()
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
    if (event.visibility === "private") continue
    upsertActivity(activities, event)
    const nextStatus = eventStatus(event.type)
    if (nextStatus && !TERMINAL.has(status)) {
      status = nextStatus
      if (TERMINAL.has(nextStatus)) endedAt = event.ts
    }

    if (event.type === "plan.created" || event.type === "plan.revised") {
      planVersion = numberValue(event.payload.version) ?? (planVersion ?? 0) + 1
      const incoming = Array.isArray(event.payload.steps) ? event.payload.steps : []
      const revisedSteps = new Map<string, RunStepSnapshot>()
      for (let index = 0; index < incoming.length; index += 1) {
        const raw = incoming[index]
        if (!raw || typeof raw !== "object") continue
        const row = raw as Record<string, unknown>
        const id = stringValue(row.id)
        if (!id) continue
        const prior = steps.get(id)
        revisedSteps.set(id, {
          ...prior,
          id: safeStableActivityId(id),
          title:
            row.safeTitle === true
              ? sanitizeActivityLabel(row.title, `Step ${index + 1}`)
              : (prior?.title ?? `Step ${index + 1}`),
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
      const title =
        event.payload.safeTitle === true
          ? sanitizeActivityLabel(event.payload.title, prior?.title ?? "Step")
          : (prior?.title ?? "Step")
      const safeSummary =
        event.payload.safeSummary === true && stringValue(event.payload.summary)
          ? sanitizeActivityLabel(event.payload.summary, "")
          : undefined
      steps.set(stepId, {
        ...prior,
        id: safeStableActivityId(stepId),
        title,
        status: nextStepStatus,
        ...(event.type === "step.started" ? { startedAt: event.ts } : {}),
        ...(nextStepStatus === "completed" || nextStepStatus === "failed"
          ? { completedAt: event.ts }
          : {}),
        ...(safeSummary ? { summary: safeSummary } : {}),
      })
    }

    if (event.type === "run.completed") summary = "Run completed"
    if (event.type === "run.failed") error = "Run failed"
    if (
      event.type === "run.waiting" ||
      event.type === "run.recovery_required" ||
      event.type === "interrupt.requested"
    ) {
      waitingReason =
        event.type === "run.recovery_required" ? "Recovery required" : "Waiting for review"
    }
    if (event.type === "interrupt.requested") {
      const id = stringValue(event.payload.interruptId)
      if (id) {
        pendingInterrupt = {
          id: safeStableActivityId(id),
          title: "Approval required",
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
      const title =
        event.payload.safeTitle === true
          ? sanitizeActivityLabel(event.payload.title, "Artifact created")
          : "Artifact created"
      if (id) {
        artifacts.push({
          id: safeStableActivityId(id),
          title,
          ...(stringValue(event.payload.mimeType)
            ? { mimeType: stringValue(event.payload.mimeType) }
            : {}),
        })
      }
    }
  }

  const allSteps = [...steps.values()]
  const completed = allSteps.filter((step) => step.status === "completed").length
  const trustworthy = planVersion !== undefined && allSteps.length > 0
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
  const activityWindow = rollingActivities(activities)

  return {
    runId: run.id,
    kind: run.kind,
    title: sanitizeActivityLabel(run.title, "Execution run"),
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
    ...activityWindow,
    elapsedMs: Math.max(0, (endedAt ?? updatedAt) - run.startedAt),
    detailsUrl: `/agent-runs?run=${encodeURIComponent(run.id)}`,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(pendingInterrupt ? { pendingInterrupt } : {}),
    artifacts,
    allowedActions: allowedActions(status, run.kind, pendingInterrupt !== undefined),
  }
}
