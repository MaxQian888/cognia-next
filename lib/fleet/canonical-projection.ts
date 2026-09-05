import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import { redactText } from "@cognia/redact"

import type { FleetOrigin, FleetSession, FleetStatus } from "./types"

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
  let hash = BigInt("0xcbf29ce484222325")
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * BigInt("0x100000001b3"))
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
  const sessionId = `external:${session.agent}:${stableRef(session.sessionId)}`
  const turnId = `fleet-turn:${Math.max(0, session.turnCount)}`
  const sequence = timestampMs * SEQUENCE_SCALE + ordinal
  return {
    schemaVersion: 1,
    eventId: `${sessionId}:${turnId}:${attemptId}:${sequence}`,
    sequence,
    sessionId,
    runId,
    turnId,
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
function originOf(envelope: AgentEventEnvelope): FleetOrigin {
  if (envelope.parentRunId) return "team"
  if (envelope.runtime.includes("workflow")) return "workflow"
  return "built-in"
}

/**
 * How long a finished canonical session stays visible in its result state.
 *
 * A run that ends is still news for a moment. Keeping the row lets the user see
 * that it finished rather than watching it vanish mid-glance, and the sweep
 * below is what stops "kept for a moment" from becoming "kept forever".
 */
export const CANONICAL_SESSION_LINGER_MS = 10_000

/** Terminal lifecycle phases. `interrupted` ends a session, it does not resume it. */
const TERMINAL_PHASES = new Set(["ended", "interrupted"])

/** True once a finished session has outlived its result state. */
export function canonicalSessionExpired(session: FleetSession, now: number): boolean {
  if (session.status !== "ended") return false
  return now - (session.endedAt ?? session.lastEventAt) > CANONICAL_SESSION_LINGER_MS
}

function seedSession(envelope: AgentEventEnvelope, now: number): FleetSession {
  return {
    agent: "cognia",
    origin: originOf(envelope),
    lifecycleConfidence: "native",
    sessionId: envelope.sessionId,
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      // A Cognia run has no agent pid, so the Rust process-signal path has
      // nothing to signal. Claiming the capability produced a stop button that
      // could never do anything. The honest affordance is the owning page,
      // until a real Cognia control adapter exists to back this flag.
      interrupt: false,
    },
    startedAt: Date.parse(envelope.timestamp) || now,
    lastEventAt: now,
    toolUseCount: 0,
    turnCount: 0,
    ...(envelope.runId ? { executionRunId: envelope.runId } : {}),
    ...(envelope.parentRunId ? { agentTeamRunId: envelope.parentRunId } : {}),
    ...(envelope.hostRef ? { hostRef: envelope.hostRef } : {}),
  }
}

/**
 * Whether the session is parked on a human. A blocked session keeps its status
 * through unrelated activity and state events: only the matching
 * `permission-resolved` / `elicitation-resolved` (or the end of the session)
 * releases it. Without this an incidental `session-state: running` cleared a
 * permission prompt the user had not answered.
 */
function blockedStatus(session: FleetSession): FleetStatus | null {
  if (session.pendingPermission) return "waiting-permission"
  if (session.pendingQuestionRequest) return "waiting-input"
  return null
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? (safe(value) ?? null) : null
}

/** Last path segment of a working directory, or null when there is none. */
export function projectNameOf(cwd: string | null): string | null {
  if (!cwd) return null
  const segments = cwd.split(/[\\/]+/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : null
}

/**
 * Fold one canonical envelope into the session row Agent Fleet shows.
 *
 * Handles the full set the runtimes actually emit rather than the five kinds
 * the first pass covered, because every unhandled kind was a fact the island
 * could not show and, worse, a state transition it could get wrong.
 */
export function projectCanonicalFleetSession(
  previous: FleetSession | undefined,
  envelope: AgentEventEnvelope,
  now = Date.now()
): FleetSession {
  const event = envelope.event as { kind?: string } & Record<string, unknown>
  const base: FleetSession = previous ?? seedSession(envelope, now)
  const next: FleetSession = { ...base, lastEventAt: now }

  // Late-arriving lineage. A run id or a parent run id can show up after the
  // first event, and it is what routes the row to its owning page.
  if (envelope.runId && !next.executionRunId) next.executionRunId = envelope.runId
  if (envelope.parentRunId && !next.agentTeamRunId) {
    next.agentTeamRunId = envelope.parentRunId
    next.origin = "team"
  }

  switch (event.kind) {
    case "lifecycle": {
      const phase = String(event.phase ?? "")
      if (TERMINAL_PHASES.has(phase)) {
        next.status = "ended"
        next.endedAt = now
        next.activity = null
        next.pendingPermission = null
        next.pendingQuestions = undefined
        next.pendingQuestionRequest = null
        if (phase === "interrupted") {
          next.lastError = {
            kind: "turn",
            detail: textOf(event.detail),
            at: now,
          }
        }
      } else {
        next.status = "working"
        next.endedAt = undefined
        next.lastError = null
      }
      break
    }

    case "session-init":
      next.model = textOf(event.model) ?? next.model
      next.permissionMode = textOf(event.permissionMode) ?? next.permissionMode
      next.cwd = textOf(event.cwd) ?? next.cwd
      // The same derivation the Rust registry applies to external agents: the
      // island and the fleet list title a row by project, and without this a
      // Cognia row's only name was its session UUID.
      next.projectName = next.projectName ?? projectNameOf(next.cwd)
      break

    case "user-input":
      next.turnCount += 1
      next.lastPrompt = textOf(event.text) ?? next.lastPrompt
      next.status = blockedStatus(next) ?? "working"
      next.lastError = null
      break

    case "tool-call":
      next.toolUseCount += 1
      next.activity = { toolName: String(event.toolName ?? "tool"), detail: null }
      next.status = blockedStatus(next) ?? "working"
      break

    case "tool-result":
      next.activity = null
      if (event.isError === true) {
        next.lastError = {
          kind: "tool",
          detail: textOf(event.toolName),
          at: now,
        }
      }
      break

    case "permission-request":
      next.pendingPermission = {
        requestId: String(event.requestId ?? ""),
        toolName: textOf(event.toolName),
        detail: null,
        requestedAt: now,
      }
      next.status = "waiting-permission"
      break

    case "permission-resolved":
      // Only the matching request clears the prompt. An unrelated resolution
      // used to release a permission the user was still looking at.
      if (next.pendingPermission?.requestId === String(event.requestId ?? "")) {
        next.pendingPermission = null
        next.status = blockedStatus(next) ?? "working"
      }
      break

    case "elicitation-request": {
      const requestId = String(event.requestId ?? "")
      const schema = event.schema as { enum?: unknown[]; type?: unknown } | undefined
      const options = Array.isArray(schema?.enum)
        ? schema.enum.filter((option): option is string => typeof option === "string")
        : []
      next.pendingQuestions = [
        {
          question: textOf(event.prompt) ?? "",
          options,
          multiSelect: schema?.enum != null && String(schema.type ?? "") === "array",
        },
      ]
      next.pendingQuestionRequest = { requestId, requestedAt: now }
      next.status = "waiting-input"
      break
    }

    case "elicitation-resolved":
      if (next.pendingQuestionRequest?.requestId === String(event.requestId ?? "")) {
        next.pendingQuestionRequest = null
        next.pendingQuestions = undefined
        next.status = blockedStatus(next) ?? "working"
      }
      break

    case "activity": {
      const phase = String(event.phase ?? "")
      if (phase === "idle") {
        next.activity = null
        next.status = blockedStatus(next) ?? "idle"
      } else {
        if (!next.activity) {
          const detail = textOf(event.detail)
          if (detail) next.activity = { toolName: detail, detail: null }
        }
        next.status = blockedStatus(next) ?? "working"
      }
      break
    }

    case "session-state": {
      const state = String(event.state ?? "")
      const blocked = blockedStatus(next)
      if (blocked) {
        next.status = blocked
      } else if (state === "running") {
        next.status = "working"
      } else if (state === "idle") {
        next.status = "idle"
      } else if (state === "requires-action") {
        // The runtime says a human is needed but has not said what for. Show
        // the wait rather than inventing a prompt the island cannot answer.
        next.status = "waiting-input"
      }
      break
    }

    case "failure":
      next.lastError = {
        kind: "turn",
        detail: textOf(event.message),
        at: now,
      }
      break
  }
  return next
}
