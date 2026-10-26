/**
 * When a failed turn should lead to a Harness Evolution run (ADR-0237).
 *
 * Only failures of the agent's own conduct qualify: it ran out of turns,
 * missed its deadline, overflowed its context, or misused delegation. A
 * provider outage, a missing key or a dead sidecar says nothing about the
 * harness, so evolving on it would spend money learning noise. Plain-string
 * errors carry no code and are never classified as harness failures.
 *
 * Pure: the chat's offer chip and the background enqueue both decide here.
 */

import type { Character } from "@cognia/agent-config-types"
import type { CogniaDiagnostic, DiagnosticCode } from "@cognia/diagnostics"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type { HarnessTaskDraft } from "./runtime/start"
import { isStartAllowed, type HarnessEvolutionSettings } from "./settings"

/** Diagnostic codes that point at the harness rather than the infrastructure. */
export const HARNESS_FAILURE_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "budgetExhausted",
  "deadlineExceeded",
  "contextWindowExceeded",
  "dispatchRejectedCycle",
  "dispatchRejectedDepth",
  "dispatchRejectedPolicy",
])

export function isHarnessFailure(diagnostic: Pick<CogniaDiagnostic, "code"> | null | undefined) {
  return !!diagnostic && HARNESS_FAILURE_CODES.has(diagnostic.code)
}

const HOUR = 60 * 60_000
/** Prompts shorter than this rarely describe a task worth evolving on. */
const MIN_PROMPT_CHARS = 12

export type FailureOfferDecision =
  | { kind: "offer" }
  | { kind: "enqueue" }
  | {
      kind: "none"
      reason:
        | "off"
        | "not-harness-failure"
        | "unsupported-agent"
        | "no-prompt"
        | "cooldown"
        | "dismissed"
        | "already-running"
    }

export interface FailureOfferInput {
  settings: Pick<HarnessEvolutionSettings, "enabled" | "startMode" | "failureOfferCooldownHours">
  diagnostic: Pick<CogniaDiagnostic, "code"> | null | undefined
  agent: Pick<Character, "id" | "runtime"> | null | undefined
  prompt: string
  /** Recent runs of the agent (any trigger). */
  runs: readonly Pick<HarnessEvolutionRun, "trigger" | "createdAt" | "sessionId" | "status">[]
  /** When the person last dismissed an offer for this agent. */
  dismissedAt?: number
  sessionId: string
  now: number
}

/**
 * What to do about a failed turn: offer a run (failure-triggered mode),
 * enqueue one (background mode), or nothing, with the reason.
 */
export function decideFailureOffer(input: FailureOfferInput): FailureOfferDecision {
  const { settings } = input
  if (!settings.enabled || !isStartAllowed(settings, "failure-triggered")) {
    return { kind: "none", reason: "off" }
  }
  if (!isHarnessFailure(input.diagnostic)) return { kind: "none", reason: "not-harness-failure" }
  const runtime = input.agent?.runtime?.kind
  if (!input.agent || (runtime && runtime !== "builtin")) {
    return { kind: "none", reason: "unsupported-agent" }
  }
  if (input.prompt.trim().length < MIN_PROMPT_CHARS) return { kind: "none", reason: "no-prompt" }
  if (
    input.runs.some(
      (r) => r.sessionId === input.sessionId && r.status !== "cancelled" && r.status !== "failed"
    )
  ) {
    // This conversation already has a run; the chip shows that run instead.
    return { kind: "none", reason: "already-running" }
  }
  const cooldownMs = settings.failureOfferCooldownHours * HOUR
  if (input.dismissedAt !== undefined && input.now - input.dismissedAt < cooldownMs) {
    return { kind: "none", reason: "dismissed" }
  }
  const recentAutomatic = input.runs.some(
    (r) => r.trigger !== "manual" && input.now - r.createdAt < cooldownMs
  )
  if (recentAutomatic) return { kind: "none", reason: "cooldown" }
  return settings.startMode === "background" ? { kind: "enqueue" } : { kind: "offer" }
}

/** The run a conversation already has, newest first, to show instead of an offer. */
export function runOfSession<T extends Pick<HarnessEvolutionRun, "sessionId" | "createdAt">>(
  runs: readonly T[],
  sessionId: string
): T | undefined {
  return [...runs]
    .filter((r) => r.sessionId === sessionId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** localStorage key of an agent's last dismissed offer. */
export function failureOfferDismissKey(agentId: string): string {
  return `cognia:harness-failure-offer-dismissed:${agentId}`
}

export interface FailedTurn {
  sessionId: string
  /** The user message the failed turn answered. */
  messageId?: string
  prompt: string
  /** The conversation's working directory, when it has one. */
  workingDirectory?: string | null
  projectId?: string
}

const TITLE_CHARS = 80

/**
 * A task draft that replays the failed request. With a working directory the
 * rollouts each get a worktree of its repository at HEAD (the start dialog can
 * switch that to a scratch directory); without one the task is text-only.
 */
export function taskDraftFromFailedTurn(turn: FailedTurn): HarnessTaskDraft {
  const firstLine =
    turn.prompt
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  const title =
    firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine
  const root = turn.workingDirectory?.trim()
  return {
    title,
    prompt: turn.prompt,
    isolation: root ? "git" : "none",
    ...(root
      ? { git: { sourceRoot: root, ...(turn.projectId ? { projectId: turn.projectId } : {}) } }
      : {}),
    checks: [],
    source: {
      kind: "session",
      sessionId: turn.sessionId,
      ...(turn.messageId ? { messageId: turn.messageId } : {}),
    },
  }
}

/** The last user request in a conversation, with its id. */
export function lastUserRequest<
  M extends { id: string; role: string; parts: readonly { type: string }[] },
>(
  messages: readonly M[],
  textOf: (parts: M["parts"]) => string
): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    const text = textOf(m.parts).trim()
    if (text) return { id: m.id, text }
  }
  return null
}
