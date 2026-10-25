/**
 * Asking a person about a browser submission the outbound policy held
 * (ADR-0239 phase 2b), the right way for whoever drives the action:
 *
 * 1. A captured turn (`lib/policy/action-review/captured-turns.ts`) asks
 *    through its own responder, as it asks about its other outbound calls: an
 *    IM card for the person in the thread, a parked approval for a scheduled
 *    task or a Bot. Its wall clock stops while the person decides.
 * 2. A desktop chat or an External Bridge client asks the person at this
 *    computer on the outbound dialog (`components/outbound/outbound-ask-dialog.tsx`).
 * 3. Anything else, or an attended ask with no dialog to show it (a headless
 *    Host), parks the question for the cockpit and a paired phone
 *    (`createUnattendedPark`).
 *
 * Every ask is bounded by {@link BROWSER_SUBMISSION_ASK_MAX_MS}, inside the
 * action tool's own budget and the runtime's hold, so the host's answer (or
 * this limit) decides. The question asks for a person only: no allow
 * list, auto-mode answer or standing grant may answer it.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"

import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { RunApprovalOrigin } from "@/lib/execution/run-approval-push"
import type { UnattendedParkOptions } from "@/lib/claude/unattended-park"
import type { OutboundTarget } from "@/lib/policy/action-review/outbound-targets"
import {
  capturedTurnOf as defaultCapturedTurnOf,
  type CapturedTurn,
} from "@/lib/policy/action-review/captured-turns"
import type {
  BrowserSubmissionAnswer,
  BrowserSubmissionAsk,
} from "@/lib/policy/action-review/plan-browser"
import {
  requestOutboundAsk as defaultRequestOutboundAsk,
  type OutboundAskResult,
} from "@/stores/outbound/outbound-ask-store"

/** How long the person at this computer has to answer. */
export const BROWSER_SUBMISSION_DIALOG_TTL_MS = 5 * 60_000

/**
 * The longest any ask waits: inside the action tools' budget
 * (`BROWSER_SUBMITTING_TOOL_TIMEOUT_MS`, the most a plugin tool may declare),
 * so the person's answer, or this limit, decides rather than the tool call
 * being cut; and well inside the runtime's hold of a reported submission.
 */
export const BROWSER_SUBMISSION_ASK_MAX_MS = 9 * 60_000

/** The tool name a question about a submission carries on cards and in the cockpit. */
export const BROWSER_SUBMISSION_TOOL_NAME = "browser_submission"

export interface BrowserSubmissionAskContext {
  /** Where the phone opens a parked question. */
  approvalOrigin: RunApprovalOrigin
  /** The parked run's title ("Browser: forms.example.com"). */
  label: string
  /** The action gave up (the tool call was cancelled): withdraw the question. */
  signal?: AbortSignal
}

export interface BrowserSubmissionAskDeps {
  capturedTurnOf?: (sessionId: string) => CapturedTurn | undefined
  requestOutboundAsk?: typeof defaultRequestOutboundAsk
  /** Test seam for the park. */
  park?: Pick<UnattendedParkOptions, "deps" | "now">
  newId?: () => string
}

/** A site as a person reads it: its origin, or `null` for a page with no site. */
export function siteOf(target: OutboundTarget): string | null {
  return target.kind === "site" ? target.recipient.replace(/^site:/, "") : null
}

/** The site a question is about, as a person reads it. */
export function askSite(ask: BrowserSubmissionAsk): string | null {
  return siteOf(ask.target)
}

/** The permission request a turn's responder or a park is asked with. */
export function browserSubmissionRequest(
  ask: BrowserSubmissionAsk,
  sessionId: string,
  requestId: string
): PermissionRequestEvent {
  const site = askSite(ask)
  return {
    type: "permission_request",
    sessionId,
    requestId,
    toolUseID: requestId,
    toolName: BROWSER_SUBMISSION_TOOL_NAME,
    input: { ...(site ? { site } : {}), basis: ask.basis, operation: ask.operation },
    title: site ? `Send to ${site}` : "Send from a page with no web address",
    permissionClass: "outbound",
    outbound: ask.review,
    // A person decides, per call: no rule, grant or auto answer may.
    suppressAlwaysAllowRule: true,
    requiresPerCallApproval: true,
    defaultToNo: true,
  }
}

/** What a responder's decision means for the submission. */
export function answerOfDecision(decision: CapturePermissionDecision): BrowserSubmissionAnswer {
  const authority = decision.attribution?.authority
  const actor = decision.attribution?.actor?.kind
  if (decision.decision === "allow") {
    return {
      kind: "allowed",
      ...(decision.forRequest ? { forRequest: true } : {}),
      ...(actor ? { actor } : {}),
    }
  }
  if (authority === "timeout") return { kind: "expired" }
  if (authority === undefined || authority === "human") {
    return { kind: "refused", ...(actor ? { actor } : {}) }
  }
  // A deny no person gave (a closed session, a profile rule) refuses this
  // submission without fencing the site.
  return { kind: "unavailable", reason: decision.message ?? `answered by ${authority}` }
}

function answerOfDialog(result: OutboundAskResult): BrowserSubmissionAnswer {
  switch (result) {
    case "once":
      return { kind: "allowed" }
    case "request":
      return { kind: "allowed", forRequest: true }
    case "refuse":
      return { kind: "refused" }
    case "expired":
      return { kind: "expired" }
    case "withdrawn":
      return { kind: "unavailable", reason: "the action was cancelled" }
  }
}

function boundedBy<T>(wait: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms)
  })
  return Promise.race([wait, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

async function askTurn(
  turn: CapturedTurn,
  respond: NonNullable<CapturedTurn["respond"]>,
  ask: BrowserSubmissionAsk,
  sessionId: string,
  requestId: string
): Promise<BrowserSubmissionAnswer> {
  const resume = turn.holdWallClock?.() ?? (() => undefined)
  try {
    return await boundedBy(
      Promise.resolve(respond(browserSubmissionRequest(ask, sessionId, requestId))).then(
        answerOfDecision,
        (error: unknown): BrowserSubmissionAnswer => ({
          kind: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        })
      ),
      BROWSER_SUBMISSION_ASK_MAX_MS,
      (): BrowserSubmissionAnswer => ({ kind: "expired" })
    )
  } finally {
    resume()
  }
}

async function askOnPhone(
  ask: BrowserSubmissionAsk,
  context: BrowserSubmissionAskContext,
  requestId: string,
  deps: BrowserSubmissionAskDeps
): Promise<BrowserSubmissionAnswer> {
  const { createUnattendedPark } = await import("@/lib/claude/unattended-park")
  const sessionId = ask.sessionId ?? `browser-submission:${ask.ownerRef}`
  const park = createUnattendedPark({
    origin: context.approvalOrigin,
    sessionId,
    label: context.label,
    ttlMs: BROWSER_SUBMISSION_ASK_MAX_MS,
    ...(context.signal ? { signal: context.signal } : {}),
    ...deps.park,
  })
  let status: "completed" | "cancelled" = "cancelled"
  try {
    const outcome = await park.park(browserSubmissionRequest(ask, sessionId, requestId))
    switch (outcome.kind) {
      case "approved":
        status = "completed"
        return answerOfDecision(outcome.decision)
      case "denied":
        status = "completed"
        return { kind: "refused", actor: "device" }
      case "expired":
        return { kind: "expired" }
      case "withdrawn":
        return { kind: "unavailable", reason: "the action was cancelled" }
    }
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await park.finish(status).catch(() => undefined)
  }
}

/** Ask a person about one submission and resolve with their answer, or why there is none. */
export async function askAboutBrowserSubmission(
  ask: BrowserSubmissionAsk,
  context: BrowserSubmissionAskContext,
  deps: BrowserSubmissionAskDeps = {}
): Promise<BrowserSubmissionAnswer> {
  const requestId = `browser-submission:${deps.newId?.() ?? crypto.randomUUID()}`
  if (context.signal?.aborted) return { kind: "unavailable", reason: "the action was cancelled" }

  const turn = ask.sessionId
    ? (deps.capturedTurnOf ?? defaultCapturedTurnOf)(ask.sessionId)
    : undefined
  if (turn?.respond && ask.sessionId) {
    return askTurn(turn, turn.respond, ask, ask.sessionId, requestId)
  }

  if (!ask.unattended) {
    const asked = (deps.requestOutboundAsk ?? defaultRequestOutboundAsk)(
      {
        site: askSite(ask),
        basis: ask.basis,
        operation: ask.operation,
        asker: ask.ownerRef.startsWith("external-bridge:") ? "external-bridge" : "chat",
        forRequestOffered: ask.forRequestOffered,
      },
      {
        ttlMs: BROWSER_SUBMISSION_DIALOG_TTL_MS,
        ...(context.signal ? { signal: context.signal } : {}),
      }
    )
    if (asked) return answerOfDialog(await asked)
    // No dialog can show it here: ask on the cockpit and the phone instead.
  }

  return askOnPhone(ask, context, requestId, deps)
}
