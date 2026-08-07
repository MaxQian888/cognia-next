import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import { redactText } from "@cognia/redact"

import type { FleetSession } from "./types"

const SEQUENCE_SCALE = 100

function safe(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return redactText(value).redacted.slice(0, 2_000)
}

/** Stable canonical run identity for a session observed by Agent Fleet. */
export function fleetCanonicalRunId(session: Pick<FleetSession, "agent" | "sessionId">): string {
  return `fleet:${session.agent}:${stableRef(session.sessionId)}`
}

function stableRef(value: string): string {
  // 64-bit FNV-1a: this is an opaque correlation ref, not a security digest. Hashing
  // keeps a provider-controlled session id (which can contain a path/email) out
  // of the durable journal while remaining stable across monitor restarts.
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

function sameActivity(a: FleetSession["activity"], b: FleetSession["activity"]): boolean {
  return a?.toolName === b?.toolName && a?.detail === b?.detail
}

function makeEnvelope(
  session: FleetSession,
  event: CanonicalAgentEvent,
  key: string,
  timestampMs: number,
  ordinal: number
): AgentEventEnvelope {
  const runId = fleetCanonicalRunId(session)
  const attemptId = `fleet-monitor:${session.startedAt}`
  return {
    schemaVersion: 1,
    eventId: `${runId}:${attemptId}:${key}`,
    sequence: timestampMs * SEQUENCE_SCALE + ordinal,
    sessionId: `external:${session.agent}:${stableRef(session.sessionId)}`,
    runId,
    turnId: `fleet-turn:${Math.max(0, session.turnCount)}`,
    attemptId,
    hostRef: session.terminal?.app ? `local-terminal:${session.terminal.app}` : "local-desktop",
    runtime: `external-${session.agent}`,
    timestamp: new Date(timestampMs).toISOString(),
    event,
  }
}

/**
 * Project a Fleet snapshot transition into the ADR-0090 canonical journal.
 *
 * Fleet snapshots contain current state rather than an event stream. Stable
 * semantic event ids make replay after remount/restart idempotent, while the
 * previous snapshot suppresses unchanged facts during normal live updates.
 * Only minimized, redacted values are persisted; raw prompts/tool payloads
 * remain in the transient Rust snapshot.
 */
export function projectFleetSessionEnvelopes(
  previous: FleetSession | undefined,
  current: FleetSession
): AgentEventEnvelope[] {
  const out: AgentEventEnvelope[] = []
  let ordinal = 0
  const freshSession = !previous || previous.startedAt !== current.startedAt
  const push = (event: CanonicalAgentEvent, key: string, at = current.lastEventAt) => {
    out.push(makeEnvelope(current, event, key, at, ordinal++))
  }

  if (freshSession) {
    push({ kind: "lifecycle", phase: "started" }, "lifecycle:started", current.startedAt)
    push(
      {
        kind: "session-init",
        ...(current.model ? { model: safe(current.model) } : {}),
        ...(current.permissionMode ? { permissionMode: safe(current.permissionMode) } : {}),
      },
      "session:init",
      current.startedAt
    )
  }

  if (
    current.lastPrompt &&
    (freshSession ||
      previous?.lastPrompt !== current.lastPrompt ||
      previous?.turnCount !== current.turnCount)
  ) {
    push(
      { kind: "user-input", text: safe(current.lastPrompt) ?? "" },
      `turn:${current.turnCount}:input`
    )
  }

  if (
    current.activity &&
    (freshSession ||
      current.toolUseCount !== previous?.toolUseCount ||
      !sameActivity(previous?.activity ?? null, current.activity))
  ) {
    push(
      {
        kind: "tool-call",
        toolName: safe(current.activity.toolName) ?? "unknown",
        input: current.activity.detail ? { detail: safe(current.activity.detail) } : {},
        toolCallId: `fleet-tool:${current.toolUseCount}`,
      },
      `tool:${current.toolUseCount}`
    )
  }

  if (
    current.pendingPermission &&
    current.pendingPermission.requestId !== previous?.pendingPermission?.requestId
  ) {
    const permission = current.pendingPermission
    push(
      {
        kind: "permission-request",
        requestId: safe(permission.requestId) ?? "permission",
        toolName: safe(permission.toolName) ?? "unknown",
        input: permission.detail ? { detail: safe(permission.detail) } : undefined,
      },
      `permission:${encodeURIComponent(safe(permission.requestId) ?? "permission")}`,
      permission.requestedAt
    )
  }

  if (
    current.pendingQuestionRequest &&
    current.pendingQuestionRequest.requestId !== previous?.pendingQuestionRequest?.requestId
  ) {
    const question = current.pendingQuestions?.[0]
    push(
      {
        kind: "elicitation-request",
        requestId: safe(current.pendingQuestionRequest.requestId) ?? "question",
        source: "external-agent-question",
        prompt: safe(question?.question) ?? "Input required",
        ...(question?.options.length
          ? {
              schema: {
                type: question.multiSelect ? "array" : "string",
                enum: question.options.map((option) => safe(option) ?? ""),
              },
            }
          : {}),
      },
      `elicitation:${encodeURIComponent(
        safe(current.pendingQuestionRequest.requestId) ?? "question"
      )}`,
      current.pendingQuestionRequest.requestedAt
    )
  }

  const previousSubagents = new Set(
    (previous?.subagents ?? []).map((item) => `${item.startedAt}:${item.description}`)
  )
  for (const subagent of current.subagents ?? []) {
    const identity = `${subagent.startedAt}:${subagent.description}`
    if (previousSubagents.has(identity)) continue
    push(
      {
        kind: "subagent",
        phase: "started",
        runtimeBinding: safe(subagent.agentType ?? subagent.description),
      },
      `subagent:${subagent.startedAt}:${encodeURIComponent(
        safe(subagent.description) ?? "subagent"
      )}`,
      subagent.startedAt
    )
  }
  const currentSubagents = new Set(
    (current.subagents ?? []).map((item) => `${item.startedAt}:${item.description}`)
  )
  for (const subagent of previous?.subagents ?? []) {
    const identity = `${subagent.startedAt}:${subagent.description}`
    if (currentSubagents.has(identity)) continue
    push(
      {
        kind: "subagent",
        phase: "ended",
        runtimeBinding: safe(subagent.agentType ?? subagent.description),
      },
      `subagent:${subagent.startedAt}:${encodeURIComponent(
        safe(subagent.description) ?? "subagent"
      )}:ended`
    )
  }

  if (current.lastError && current.lastError.at !== previous?.lastError?.at) {
    push(
      {
        kind: "failure",
        code: `fleet_${current.lastError.kind}_error`,
        message: safe(current.lastError.detail) ?? `${current.lastError.kind} failed`,
      },
      `failure:${current.lastError.at}`,
      current.lastError.at
    )
  }

  if (
    freshSession ||
    current.status !== previous?.status ||
    !sameActivity(previous?.activity ?? null, current.activity)
  ) {
    const requesting = current.status === "working"
    push(
      {
        kind: "activity",
        phase: requesting ? "requesting" : "idle",
        detail: safe(current.activity?.toolName ?? current.status),
      },
      `activity:${current.status}:${current.lastEventAt}`
    )
    const state =
      current.status === "working"
        ? "running"
        : current.status === "waiting-input" ||
            current.status === "waiting-permission" ||
            current.status === "plan-pending"
          ? "requires-action"
          : "idle"
    push({ kind: "session-state", state }, `state:${current.status}:${current.lastEventAt}`)
  }

  if (current.status === "ended" && previous?.status !== "ended") {
    push(
      { kind: "lifecycle", phase: "ended" },
      "lifecycle:ended",
      current.endedAt ?? current.lastEventAt
    )
  }

  return out
}
