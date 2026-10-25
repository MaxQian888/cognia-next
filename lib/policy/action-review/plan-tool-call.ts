/**
 * The tool-call chokepoint of the outbound policy (ADR-0239).
 *
 * Every path that answers a `permission_request` asks this module about an
 * outbound tool before it shows a card, consults an allow list or parks the
 * call: the desktop chat listener (`hooks/chat/claude-chat-events.ts`) and the
 * team room (`lib/chat/room/runner.ts`) through {@link planOutboundAsk}; the
 * headless captures (`lib/claude/run-and-capture.ts`), the scheduler's own
 * loop and the CLI through {@link answerWithOutboundPolicy}. Each gets the
 * same answer from {@link outboundToolDecision}:
 *
 * - `allow`: answer the call at once, with the authority and grant the plan
 *   names (the origin thread, an instruction grant, a policy list);
 * - `deny`: refuse it at once with the fence's message, authority
 *   `policy-deny`;
 * - `ask`: a person decides, and no allow list, auto-mode answer or standing
 *   grant may decide for them;
 * - `unchanged`: shadow mode, so the caller does what it did before.
 *
 * Whatever the decision, the plan is attached to the call's chat-tool review,
 * so the receipt written when the call settles carries its targets, root
 * session, epoch and plan, and a person's deny on it fences the recipient.
 * A call that names its `toolUseID` also has its recipients remembered for
 * the connector delivery it causes (`authorized-tool-calls.ts`); an allow
 * this module answers promotes it there before the answer is dispatched.
 *
 * A call a shortcut allowed inside the sidecar never asks at all; in shadow
 * mode the sidecar reports it (`explicit_tool_allowed`) and
 * {@link recordOutboundShadowObservation} writes its receipt.
 */

import type { ExplicitToolAllowedEvent, PendingOutboundReview } from "@cognia/agent-config-types"
import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewAuthority,
  type ActionReviewGrant,
  type ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { resolveRootSessionId } from "@/lib/claude/agents/root-session"
import { classifyRisk } from "@/lib/policy/risk/classify-risk"
import { isOutboundToolId, normalizeToolId } from "@/lib/policy/risk/outbound-tools"

import { authorizeOutboundToolCall, rememberPlannedOutboundToolCall } from "./authorized-tool-calls"
import { annotateChatToolReview } from "./chat-tool-channel"
import {
  extractOutboundTargets,
  outboundFingerprint,
  toReviewTarget,
  type OutboundTarget,
} from "./outbound-targets"
import { configuredPolicyGrants } from "./configured-grants"
import {
  buildActionReviewPlanContext,
  readAppSettings,
  type ActionReviewPlanOrigin,
  type OutboundPolicyGrantList,
  type OutboundSettingsLike,
} from "./plan-context"
import { humanOutboundGrant, planActionReview, type ActionReviewPlanResult } from "./policy"
import { projectActionReviewSettled } from "./projection"
import { resolveSessionRequestOrigin } from "./resolve-request-origin"

export interface OutboundToolCallRequest {
  sessionId: string
  requestId: string
  toolName: string
  input: unknown
  /**
   * The tool use the request asks about (`PermissionRequestEvent.toolUseID`).
   * Without it the call's deliveries cannot be told apart from any other and
   * are planned on their own.
   */
  toolUseID?: string
}

export interface OutboundToolCallPlan {
  /** The recipients in full, for the card. Never persisted. */
  targets: OutboundTarget[]
  rootSessionId: string
  instructionEpoch: string
  result: ActionReviewPlanResult
}

type SettingsLike = OutboundSettingsLike

export interface OutboundToolPlannerOptions {
  /** No person is watching the run. */
  unattended: boolean
  /**
   * The origin of a run that carries its own: a scheduled task
   * (`taskPlanOrigin`) or a Bot (`botPlanOrigin`). Default: the session's,
   * through `resolveSessionRequestOrigin`.
   */
  origin?: ActionReviewPlanOrigin | (() => Promise<ActionReviewPlanOrigin>)
  /** Recipient lists a person configured for this run (a Bot installation's). */
  policyGrants?: readonly OutboundPolicyGrantList[]
  /**
   * The lists configured on the targets' connector instances and
   * conversations. Default: {@link configuredPolicyGrants}.
   */
  configuredGrants?: (targets: readonly OutboundTarget[]) => Promise<OutboundPolicyGrantList[]>
  /** App settings, for the mode. Default: the settings store. */
  settings?: () => SettingsLike | Promise<SettingsLike>
  now?: () => number
  /**
   * Attach the plan to the call's chat-tool review (default true). A path
   * whose calls open no review (the CLI tool host) passes false.
   */
  annotateReview?: boolean
}

export type OutboundToolPlanner = (
  request: OutboundToolCallRequest
) => Promise<OutboundToolCallPlan | null>

/** The authority and grant an answer is recorded under, as `approveTool` takes them. */
export interface OutboundAttribution {
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
}

export type OutboundToolDecision =
  | { kind: "allow"; attribution: OutboundAttribution }
  | { kind: "deny"; message: string; attribution: OutboundAttribution }
  | { kind: "ask" }
  | { kind: "unchanged" }

async function originOf(
  request: OutboundToolCallRequest,
  given: OutboundToolPlannerOptions["origin"]
): Promise<{ origin: ActionReviewPlanOrigin; rootSessionId: string; instructionEpoch: string }> {
  const origin = typeof given === "function" ? await given() : given
  if (origin) {
    const rootSessionId = origin.rootSessionId ?? resolveRootSessionId(request.sessionId)
    return {
      origin,
      rootSessionId,
      instructionEpoch: origin.instructionEpoch ?? `none:${rootSessionId}`,
    }
  }
  const resolved = await resolveSessionRequestOrigin(request.sessionId)
  return {
    origin: {
      rootSessionId: resolved.rootSessionId,
      instructionEpoch: resolved.instructionEpoch,
      ...(resolved.originThread ? { originThread: resolved.originThread } : {}),
    },
    rootSessionId: resolved.rootSessionId,
    instructionEpoch: resolved.instructionEpoch,
  }
}

/**
 * Plan one outbound tool call, and attach the plan to its chat-tool review.
 * `null` for a tool that is not outbound.
 */
export async function planOutboundToolCall(
  request: OutboundToolCallRequest,
  options: OutboundToolPlannerOptions
): Promise<OutboundToolCallPlan | null> {
  return planCall(request, options, options.annotateReview !== false)
}

async function planCall(
  request: OutboundToolCallRequest,
  options: OutboundToolPlannerOptions,
  annotate: boolean
): Promise<OutboundToolCallPlan | null> {
  if (!isOutboundToolId(request.toolName)) return null
  const { origin, rootSessionId, instructionEpoch } = await originOf(request, options.origin)
  // A tool that names no bot (an `im_create_chat` with no `adapterId`) sends
  // through the bot of the conversation the run is bound to.
  const targets = extractOutboundTargets(request.toolName, request.input, {
    ...(origin.originThread ? { defaultAdapterId: origin.originThread.channel } : {}),
  })
  // The run's own lists (a Bot's), and the ones a person configured on the
  // bots and conversations these targets go through.
  const policyGrants = [
    ...(options.policyGrants ?? []),
    ...(await (options.configuredGrants ?? configuredPolicyGrants)(targets)),
  ]
  const context = await buildActionReviewPlanContext({
    origin: { ...origin, rootSessionId, instructionEpoch },
    unattended: options.unattended,
    via: "tool",
    settings: await (options.settings ?? readAppSettings)(),
    ...(policyGrants.length > 0 ? { policyGrants } : {}),
    ...(options.now ? { now: options.now() } : {}),
  })
  const result = planActionReview({ verdict: "ask", targets }, context)
  if (request.toolUseID) {
    rememberPlannedOutboundToolCall({
      sessionId: request.sessionId,
      requestId: request.requestId,
      toolUseId: request.toolUseID,
      toolName: normalizeToolId(request.toolName),
      fingerprints: targets.map((target) => outboundFingerprint(target)),
    })
  }
  if (annotate) {
    annotateChatToolReview(request.sessionId, request.requestId, {
      targets: targets.map(toReviewTarget),
      rootSessionId,
      instructionEpoch,
      plan: result.plan,
    })
  }
  return { targets, rootSessionId, instructionEpoch, result }
}

/** A planner bound to one run's options. */
export function createOutboundToolPlanner(
  options: OutboundToolPlannerOptions
): OutboundToolPlanner {
  return (request) => planOutboundToolCall(request, options)
}

/** Model-facing text for a fenced call. English on purpose: the model reads it. */
export function outboundFenceMessage(toolName: string): string {
  return (
    `denied: a person already refused sending to this recipient for the current request ` +
    `("${toolName}"). Do not retry it with another tool, recipient alias or wording. ` +
    `Finish without it and say what you would have sent.`
  )
}

/** What a caller does with a plan. See the module comment. */
export function outboundToolDecision(
  plan: OutboundToolCallPlan,
  toolName: string
): OutboundToolDecision {
  const { result } = plan
  if (!result.plan.enforced) return { kind: "unchanged" }
  switch (result.plan.outcome) {
    case "allow":
      return {
        kind: "allow",
        attribution: {
          authority: result.authority ?? "policy-default",
          ...(result.grant ? { grant: result.grant } : {}),
        },
      }
    case "deny":
      return {
        kind: "deny",
        message: outboundFenceMessage(toolName),
        attribution: { authority: "policy-deny" },
      }
    case "ask":
    case "park":
    case "draft":
      return { kind: "ask" }
  }
}

/** The recipients an approval card shows (ADR-0239 WP7 renders them). */
export function pendingOutboundReview(plan: OutboundToolCallPlan): PendingOutboundReview {
  const view = (target: OutboundTarget) => ({
    kind: target.kind,
    channel: target.channel,
    recipient: target.recipient,
  })
  return {
    targets: plan.targets.map(view),
    unauthorized: plan.result.unauthorized.map(view),
    enforced: plan.result.plan.enforced,
  }
}

export { humanOutboundGrant } from "./policy"

/**
 * Record a shadow-mode observation: an outbound call a permission shortcut let
 * through without asking anyone. The call already ran or is running; the
 * receipt keeps what the outbound policy would have decided about it.
 */
export async function recordOutboundShadowObservation(
  event: Pick<ExplicitToolAllowedEvent, "sessionId" | "toolName" | "input" | "toolUseID">,
  options: OutboundToolPlannerOptions
): Promise<void> {
  const requestId = `explicit:${event.toolUseID ?? crypto.randomUUID()}`
  const now = options.now?.() ?? Date.now()
  // No review was opened for it, so there is nothing to annotate.
  const planned = await planCall(
    { sessionId: event.sessionId, requestId, toolName: event.toolName, input: event.input },
    options,
    false
  )
  if (!planned) return
  const risk = classifyRisk({
    objective: "",
    taskDescriptions: [],
    toolIds: [event.toolName],
    capabilityIds: [],
    sandboxEnabled: false,
  })
  const request: ActionReviewRequest = {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId,
    origin: {
      channel: "chat-tool",
      scope: "chat",
      id: requestId,
      sessionId: event.sessionId,
      rootSessionId: planned.rootSessionId,
      instructionEpoch: planned.instructionEpoch,
      ...(options.unattended ? { headless: true } : {}),
    },
    subject: {
      kind: "tool-call",
      ref: event.toolName,
      targets: planned.targets.map(toReviewTarget),
    },
    // A shortcut allowed it: the ladder's verdict, explicit or not, was allow.
    verdict: "allow",
    verdictExplicit: false,
    tier: risk.tier,
    surfaces: risk.surfaces,
    plan: planned.result.plan,
    requestedAt: now,
  }
  await projectActionReviewSettled(request, {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId,
    outcome: "allow",
    authority: "policy-rule",
    reason:
      "allowed by a permission shortcut without asking (outbound authorization in shadow mode)",
    decidedAt: now,
  })
}

/** A responder's answer, as `RunAndCaptureOptions.onPermissionRequest` returns it. */
export interface OutboundAwareDecision {
  decision: "allow" | "allow_always" | "deny"
  message?: string
  updatedInput?: unknown
  attribution?: OutboundAttribution & {
    actor?: { kind: "local-user" | "device" | "connector-user"; id?: string; label?: string }
  }
  /**
   * From a responder, on an allow: the person allowed these recipients for
   * the rest of the request, not just this call. Never returned.
   */
  forRequest?: boolean
  /**
   * Returned on an allowed outbound ask: the grant the person's allow rests
   * on. The caller adds it to whatever attribution it records the answer
   * with, which for an IM card it only learns after the responder returns.
   */
  grant?: ActionReviewGrant
}

type PermissionRequestLike = OutboundToolCallRequest & {
  suppressAlwaysAllowRule?: boolean
  requiresPerCallApproval?: boolean
  defaultToNo?: boolean
  outbound?: PendingOutboundReview
}

/**
 * Answer a permission request with the outbound policy first, for the
 * headless paths that hand requests to a responder (`run-and-capture`, the
 * scheduler's own loop).
 *
 * An enforced plan that allows or denies answers the request itself. One that
 * leaves it to a person hands the responder a request marked approve-per-call,
 * so no standing grant can come of it, carrying the recipients
 * (`PermissionRequestEvent.outbound`) for its card. An allow comes back with
 * `grant`: `instruction` when the person allowed it for the request
 * (`forRequest`) and every recipient can be granted, else `once`. A tool that
 * is not outbound, or shadow mode, goes to the responder unchanged. A planning
 * failure in enforce mode never allows: the request goes to the responder as a
 * per-call ask, with no recipients to name.
 */
export async function answerWithOutboundPolicy<R extends PermissionRequestLike>(
  request: R,
  options: OutboundToolPlannerOptions,
  respond: (request: R) => OutboundAwareDecision | Promise<OutboundAwareDecision>
): Promise<OutboundAwareDecision> {
  if (!isOutboundToolId(request.toolName)) return respond(request)
  let decision: OutboundToolDecision
  let review: PendingOutboundReview | undefined
  try {
    const plan = await planOutboundToolCall(request, options)
    decision = plan ? outboundToolDecision(plan, request.toolName) : { kind: "unchanged" }
    if (plan) review = pendingOutboundReview(plan)
  } catch (error) {
    console.warn("[outbound] planning failed; leaving the call to a person", error)
    const { readOutboundAuthorizationMode } = await import("./policy")
    const mode = readOutboundAuthorizationMode(await (options.settings ?? readAppSettings)())
    decision = mode === "enforce" ? { kind: "ask" } : { kind: "unchanged" }
  }
  switch (decision.kind) {
    case "allow":
      authorizeOutboundToolCall(request.sessionId, request.requestId, decision.attribution)
      return { decision: "allow", attribution: decision.attribution }
    case "deny":
      return { decision: "deny", message: decision.message, attribution: decision.attribution }
    case "unchanged":
      return respond(request)
    case "ask": {
      const reply = await respond({
        ...request,
        suppressAlwaysAllowRule: true,
        requiresPerCallApproval: true,
        defaultToNo: true,
        ...(review ? { outbound: review } : {}),
      })
      // The grant is the policy's to name, never the responder's.
      const { forRequest, grant: _fromResponder, ...answer } = reply
      // A per-call answer never becomes a standing rule.
      if (answer.decision === "deny") return answer
      const grant = humanOutboundGrant(forRequest, review)
      // Only a person answers an enforced ask.
      authorizeOutboundToolCall(request.sessionId, request.requestId, {
        authority: "human",
        grant,
      })
      return { ...answer, decision: "allow", grant }
    }
  }
}

/** What the outbound policy made of an interactive ask. */
export type OutboundAsk =
  { answered: true } | { answered: false; review?: PendingOutboundReview; personOnly: boolean }

/**
 * Plan an outbound ask for a path that shows cards (the desktop chat
 * listener, the team room). An enforced allow or deny is answered through
 * `approve` here. An enforced ask is `personOnly`: no allow list, auto-mode
 * decision or standing grant may answer it. Shadow mode only records the plan
 * (`personOnly: false`), and a planning failure under enforcement leaves the
 * call to a person rather than letting a shortcut allow it. `null` for a tool
 * that is not outbound.
 */
export async function planOutboundAsk(
  request: OutboundToolCallRequest,
  options: OutboundToolPlannerOptions,
  approve: (
    decision: "allow" | "deny",
    message: string | undefined,
    attribution: OutboundAttribution
  ) => Promise<void>
): Promise<OutboundAsk | null> {
  if (!isOutboundToolId(request.toolName)) return null
  let plan: OutboundToolCallPlan | null
  try {
    plan = await planOutboundToolCall(request, options)
  } catch (error) {
    console.error("[outbound] planning failed", error)
    const { readOutboundAuthorizationMode } = await import("./policy")
    const mode = readOutboundAuthorizationMode(await (options.settings ?? readAppSettings)())
    return { answered: false, personOnly: mode === "enforce" }
  }
  if (!plan) return null
  const decision = outboundToolDecision(plan, request.toolName)
  if (decision.kind === "allow" || decision.kind === "deny") {
    if (decision.kind === "allow") {
      authorizeOutboundToolCall(request.sessionId, request.requestId, decision.attribution)
    }
    try {
      await approve(
        decision.kind,
        decision.kind === "deny" ? decision.message : undefined,
        decision.attribution
      )
    } catch (error) {
      console.error("[outbound] answering the call failed", error)
    }
    return { answered: true }
  }
  return {
    answered: false,
    review: pendingOutboundReview(plan),
    personOnly: decision.kind === "ask",
  }
}
