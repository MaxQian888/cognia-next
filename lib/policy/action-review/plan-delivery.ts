/**
 * The connector delivery chokepoint of the outbound policy (ADR-0239).
 *
 * Every automated delivery the gateway (`lib/connectors/delivery-gateway.ts`)
 * persists is planned here first. The caller says what authorizes it, as an
 * {@link OutboundAuthorization}; this module checks that claim and, where the
 * claim does not settle it, asks the engine (`planActionReview`, `via:
 * "delivery"`, always unattended: nobody is asked at this point, so a
 * delivery nothing authorized becomes a draft).
 *
 * | authorization   | checked how                                                        |
 * | --------------- | ------------------------------------------------------------------ |
 * | `tool-call`     | the call is in `authorized-tool-calls.ts` and planned this target   |
 * | `plugin`        | one of the plugin's running, authorized calls planned this target   |
 * | `human`         | a person confirmed this very action (an IM confirm card)            |
 * | `origin-reply`  | the target is the conversation the reply answers                    |
 * | `system-notice` | the target is the conversation the card or notice belongs to        |
 * | `rerouted`      | the target is the same chat as the job it replaces                  |
 * | `unattended`    | the engine, in the run's own origin                                 |
 *
 * A tool call or plugin whose claim does not hold is planned as unattended in
 * its session's origin rather than refused: what it sends into the origin
 * thread still goes, anything else is drafted. A reply, notice or reroute
 * whose target is another conversation is refused: those claims are made by
 * host code that knows exactly where it is replying, so a mismatch is a bug,
 * and neither a draft of a card nor a guess at the right chat helps anyone.
 *
 * A person's own send (`manual`, `draft-approved`) needs no authorization.
 * Any other source that names none is planned as unattended with no origin.
 *
 * ## Receipts
 *
 * - Enforce mode: every delivery the policy drafts or refuses, and every one
 *   it allows on a grant or a person's confirmation, writes a
 *   `connector-delivery` receipt. A delivery into the origin thread and one a
 *   tool call authorized write none: the first needs no grant, the second is
 *   on the call's own receipt (`authorizedBy.receiptId`).
 * - Shadow mode: only a delivery enforcement would have drafted or refused
 *   writes one, recording what would have happened. A tool call the host has
 *   no record of is not one of them: in shadow mode a permission shortcut can
 *   still answer an outbound call without asking, so a missing record says
 *   nothing about what enforcement would do.
 */

import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewActorKind,
  type ActionReviewAuthority,
  type ActionReviewDecision,
  type ActionReviewGrant,
  type ActionReviewOutcome,
  type ActionReviewPlan,
  type ActionReviewPlanOutcome,
  type ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import type {
  OutboundJobAuthorization,
  OutboundJobSource,
} from "@cognia/plugin-contract/lib/db/connector-types"

import { classifyRisk } from "@/lib/policy/risk/classify-risk"
import { parseConversationKey } from "@/types/connectors/event"

import {
  authorizedOutboundToolCall,
  runningAuthorizedToolCallsOf,
  type AuthorizedOutboundToolCall,
} from "./authorized-tool-calls"
import {
  conversationTarget,
  outboundFingerprint,
  toReviewTarget,
  type OutboundTarget,
} from "./outbound-targets"
import {
  buildActionReviewPlanContext,
  readAppSettings,
  type ActionReviewPlanOrigin,
  type OutboundPolicyGrantList,
  type OutboundSettingsLike,
} from "./plan-context"
import {
  planActionReview,
  readOutboundAuthorizationMode,
  type OutboundAuthorizationMode,
} from "./policy"
import { resolveSessionRequestOrigin } from "./resolve-request-origin"

/** A reply into the conversation the request came from. */
export interface OriginReplyAuthorization {
  kind: "origin-reply"
  /** The conversation the triggering message or click arrived in. */
  inboundConversationKey: string
}

/** A card or notice the system posts into the conversation it belongs to. */
export interface SystemNoticeAuthorization {
  kind: "system-notice"
  /** The conversation the card, command or click belongs to. */
  inboundConversationKey: string
}

/** The outbound runner moving a job to a sibling bot of the same chat. */
export interface ReroutedAuthorization {
  kind: "rerouted"
  from: { conversationKey: string; authorizedBy?: OutboundJobAuthorization }
}

/** Authorizations the gateway only queues or refuses, never drafts. */
export type InThreadAuthorization =
  OriginReplyAuthorization | SystemNoticeAuthorization | ReroutedAuthorization

/** What a caller says authorizes one automated delivery (ADR-0239). */
export type OutboundAuthorization =
  /**
   * Made by an outbound tool while it runs, naming its call. The host's
   * record of the call (`authorized-tool-calls.ts`) decides, not the claim.
   */
  | {
      kind: "tool-call"
      sessionId: string
      toolUseId: string
      /**
       * The delivery goes into a conversation the call itself just created
       * (`im_create_chat`, `im_dispatch_task`), which no plan could name: it is
       * covered by the people the call was authorized to reach.
       */
      createdConversation?: boolean
    }
  /** Plugin code (`ctx.connectors.enqueueSend`, `ctx.skills.invokeBuiltIn`). */
  | { kind: "plugin"; pluginId: string }
  /** A person confirmed this very action: the IM confirm card of a built-in skill. */
  | { kind: "human"; actor: ActionReviewActorKind }
  | OriginReplyAuthorization
  | SystemNoticeAuthorization
  /** A schedule, workflow, Bot, notification or plugin with no person in the loop. */
  | {
      kind: "unattended"
      /** Who is sending, for the receipt and the draft: `task:<id>`, `workflow:<id>`, … */
      ownerRef: string
      /** The run's origin. Default: the origin of `sessionId`, else none. */
      origin?: ActionReviewPlanOrigin
      /** The session the delivery belongs to, if any. */
      sessionId?: string
      /** Recipient lists a person configured for this sender. */
      policyGrants?: readonly OutboundPolicyGrantList[]
    }
  | ReroutedAuthorization

export interface DeliveryPlanInput {
  adapterId: string
  conversationKey: string
  source: OutboundJobSource
  authorization?: OutboundAuthorization
}

/** A `connector-delivery` receipt, for the gateway to write. */
export interface DeliveryReceipt {
  request: ActionReviewRequest
  decision: ActionReviewDecision
}

export type DeliveryDenyReason =
  /** A person refused this recipient for the current request. */
  | "fenced"
  /** A reply, notice or reroute named a conversation other than its own. */
  | "conversation-mismatch"

export type DeliveryDecision =
  | { action: "send"; authorizedBy?: OutboundJobAuthorization; receipt?: DeliveryReceipt }
  | { action: "draft"; draftSessionId: string; receipt: DeliveryReceipt }
  | { action: "deny"; reason: DeliveryDenyReason; receipt: DeliveryReceipt }

export interface PlanDeliveryDeps {
  /** App settings, for the mode. Default: the settings store. */
  settings?: () => OutboundSettingsLike | Promise<OutboundSettingsLike>
  /** A session's origin. Default: `resolveSessionRequestOrigin`. */
  resolveSessionOrigin?: (sessionId: string) => Promise<ActionReviewPlanOrigin>
  /** Test seam for the fence and grant query. */
  listAuthKeys?: (prefix: string, now: number) => Promise<string[]>
  now?: () => number
  newRequestId?: () => string
}

/** A person's own send. */
const HUMAN_SOURCES: ReadonlySet<OutboundJobSource> = new Set(["manual", "draft-approved"])

/** Tools that deliver into a conversation they create (`createdConversation`). */
const CONVERSATION_CREATING_TOOLS: ReadonlySet<string> = new Set([
  "im_create_chat",
  "im_dispatch_task",
])

/** Whether two conversation keys reach the same chat: platform and chat id, any bot, any thread. */
export function sameChat(a: string, b: string): boolean {
  try {
    const left = parseConversationKey(a.trim())
    const right = parseConversationKey(b.trim())
    return (
      left.remoteChatId !== "" &&
      left.platform === right.platform &&
      left.remoteChatId === right.remoteChatId
    )
  } catch {
    return false
  }
}

function deliveryTarget(input: DeliveryPlanInput): OutboundTarget {
  return (
    conversationTarget(input.conversationKey) ?? {
      kind: "unknown",
      channel: input.adapterId,
      recipient: "*",
    }
  )
}

function fromToolCall(call: AuthorizedOutboundToolCall): OutboundJobAuthorization {
  return {
    receiptId: call.requestId,
    authority: call.authority,
    ...(call.grant ? { grantScope: call.grant.scope } : {}),
    ...(call.grant?.policyRef ? { policyRef: call.grant.policyRef } : {}),
  }
}

function covers(
  call: AuthorizedOutboundToolCall,
  target: OutboundTarget,
  createdConversation: boolean | undefined
): boolean {
  if (call.fingerprints.includes(outboundFingerprint(target))) return true
  return (
    createdConversation === true &&
    target.kind === "conversation" &&
    CONVERSATION_CREATING_TOOLS.has(call.toolName)
  )
}

interface PlanningEnv {
  input: DeliveryPlanInput
  target: OutboundTarget
  mode: OutboundAuthorizationMode
  settings: OutboundSettingsLike
  now: number
  deps: PlanDeliveryDeps
}

interface ReceiptArgs {
  ownerRef?: string
  sessionId?: string
  origin?: ActionReviewPlanOrigin
  plan: ActionReviewPlanOutcome
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
  actor?: { kind: ActionReviewActorKind }
  reason: string
}

function receiptFor(env: PlanningEnv, args: ReceiptArgs): DeliveryReceipt {
  const requestId = `delivery:${env.deps.newRequestId?.() ?? crypto.randomUUID()}`
  const risk = classifyRisk({
    objective: "",
    taskDescriptions: [],
    toolIds: ["connector_send"],
    capabilityIds: [],
    sandboxEnabled: false,
  })
  const plan: ActionReviewPlan = { outcome: args.plan, enforced: env.mode === "enforce" }
  const permits = args.outcome === "allow" || args.outcome === "allow_always"
  return {
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId,
      origin: {
        channel: "connector-delivery",
        scope: "connector",
        id: requestId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        // Nobody is asked at the delivery chokepoint.
        headless: true,
        ...(args.origin?.rootSessionId ? { rootSessionId: args.origin.rootSessionId } : {}),
        ...(args.origin?.instructionEpoch
          ? { instructionEpoch: args.origin.instructionEpoch }
          : {}),
      },
      subject: {
        kind: "connector-delivery",
        ref: args.ownerRef ?? env.input.source,
        targets: [toReviewTarget(env.target)],
      },
      verdict: "ask",
      verdictExplicit: false,
      tier: risk.tier,
      surfaces: risk.surfaces,
      plan,
      requestedAt: env.now,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId,
      outcome: args.outcome,
      authority: args.authority,
      reason: args.reason,
      ...(args.grant && permits ? { grant: args.grant } : {}),
      ...(args.actor ? { actor: args.actor } : {}),
      decidedAt: env.now,
    },
  }
}

/**
 * The plan's outcome as the delivery sees it: drafted or refused under
 * enforcement, sent and recorded under shadow mode.
 */
function withheld(
  env: PlanningEnv,
  outcome: "draft" | "deny",
  args: Omit<ReceiptArgs, "plan" | "outcome" | "authority" | "reason"> & {
    denyReason?: DeliveryDenyReason
    draftSessionId?: string
  }
): DeliveryDecision {
  const what =
    outcome === "draft"
      ? "nothing authorized its recipient"
      : args.denyReason === "fenced"
        ? "a person refused its recipient for the current request"
        : "it named a conversation other than the one it answers"
  if (env.mode === "shadow") {
    return {
      action: "send",
      receipt: receiptFor(env, {
        ...args,
        plan: outcome,
        outcome: "allow",
        authority: "policy-default",
        reason: `delivered: outbound authorization is in shadow mode; enforcement would have ${
          outcome === "draft" ? "held it as a draft" : "refused it"
        } (${what})`,
      }),
    }
  }
  if (outcome === "draft") {
    return {
      action: "draft",
      draftSessionId: args.draftSessionId ?? args.sessionId ?? args.ownerRef ?? env.input.source,
      receipt: receiptFor(env, {
        ...args,
        plan: "draft",
        outcome: "deny",
        authority: "policy-default",
        reason: `held as a draft for a person to approve: ${what}`,
      }),
    }
  }
  return {
    action: "deny",
    reason: args.denyReason ?? "conversation-mismatch",
    receipt: receiptFor(env, {
      ...args,
      plan: "deny",
      outcome: "deny",
      authority: "policy-deny",
      reason: `refused: ${what}`,
    }),
  }
}

async function planUnattended(
  env: PlanningEnv,
  unattended: {
    ownerRef: string
    origin?: ActionReviewPlanOrigin
    sessionId?: string
    policyGrants?: readonly OutboundPolicyGrantList[]
  }
): Promise<DeliveryDecision> {
  let origin: ActionReviewPlanOrigin = unattended.origin ?? {}
  let result: ReturnType<typeof planActionReview>
  try {
    if (!unattended.origin && unattended.sessionId) {
      origin = await (env.deps.resolveSessionOrigin ?? defaultSessionOrigin)(unattended.sessionId)
    }
    const context = await buildActionReviewPlanContext({
      origin,
      unattended: true,
      via: "delivery",
      settings: env.settings,
      ...(unattended.policyGrants ? { policyGrants: unattended.policyGrants } : {}),
      now: env.now,
      ...(env.deps.listAuthKeys ? { listAuthKeys: env.deps.listAuthKeys } : {}),
    })
    result = planActionReview({ verdict: "ask", targets: [env.target] }, context)
  } catch (error) {
    // Shadow mode changes nothing, so a planning failure must not either.
    // Under enforcement nothing was shown to authorize the recipient, so the
    // delivery waits for a person rather than going out on a failure.
    console.warn("[outbound] delivery planning failed", error)
    if (env.mode === "shadow") return { action: "send" }
    return withheld(env, "draft", {
      ownerRef: unattended.ownerRef,
      ...(unattended.sessionId ? { sessionId: unattended.sessionId } : {}),
      origin,
      draftSessionId: unattended.sessionId ?? origin.rootSessionId ?? unattended.ownerRef,
    })
  }
  const receiptArgs = {
    ownerRef: unattended.ownerRef,
    ...(unattended.sessionId ? { sessionId: unattended.sessionId } : {}),
    origin,
  }

  switch (result.plan.outcome) {
    case "allow": {
      const authority = result.authority ?? "policy-default"
      if (!result.grant) {
        // The origin thread: needs no grant and no receipt.
        return { action: "send", authorizedBy: { authority } }
      }
      const receipt =
        env.mode === "enforce"
          ? receiptFor(env, {
              ...receiptArgs,
              plan: "allow",
              outcome: "allow",
              authority,
              grant: result.grant,
              reason: `allowed by a ${result.grant.scope} grant`,
            })
          : undefined
      return {
        action: "send",
        authorizedBy: {
          ...(receipt ? { receiptId: receipt.request.requestId } : {}),
          authority,
          grantScope: result.grant.scope,
          ...(result.grant.policyRef ? { policyRef: result.grant.policyRef } : {}),
        },
        ...(receipt ? { receipt } : {}),
      }
    }
    case "deny":
      return withheld(env, "deny", { ...receiptArgs, denyReason: "fenced" })
    case "ask":
    case "draft":
    case "park":
      return withheld(env, "draft", {
        ...receiptArgs,
        draftSessionId: unattended.sessionId ?? origin.rootSessionId ?? unattended.ownerRef,
      })
  }
}

async function defaultSessionOrigin(sessionId: string): Promise<ActionReviewPlanOrigin> {
  const resolved = await resolveSessionRequestOrigin(sessionId)
  return {
    rootSessionId: resolved.rootSessionId,
    instructionEpoch: resolved.instructionEpoch,
    ...(resolved.originThread ? { originThread: resolved.originThread } : {}),
  }
}

/** Plan one delivery. See the module comment for what each authorization means. */
export async function planDelivery(
  input: DeliveryPlanInput,
  deps: PlanDeliveryDeps = {}
): Promise<DeliveryDecision> {
  const auth = input.authorization
  if (!auth && HUMAN_SOURCES.has(input.source)) return { action: "send" }

  const settings = await (deps.settings ?? readAppSettings)()
  const env: PlanningEnv = {
    input,
    target: deliveryTarget(input),
    mode: readOutboundAuthorizationMode(settings),
    settings,
    now: deps.now?.() ?? Date.now(),
    deps,
  }

  if (!auth) return planUnattended(env, { ownerRef: `source:${input.source}` })

  switch (auth.kind) {
    case "origin-reply":
    case "system-notice":
      return sameChat(auth.inboundConversationKey, input.conversationKey)
        ? { action: "send", authorizedBy: { authority: "policy-default" } }
        : withheld(env, "deny", { denyReason: "conversation-mismatch" })
    case "rerouted":
      if (!sameChat(auth.from.conversationKey, input.conversationKey)) {
        return withheld(env, "deny", { denyReason: "conversation-mismatch" })
      }
      return auth.from.authorizedBy
        ? { action: "send", authorizedBy: auth.from.authorizedBy }
        : { action: "send" }
    case "human": {
      const receipt =
        env.mode === "enforce"
          ? receiptFor(env, {
              plan: "allow",
              outcome: "allow",
              authority: "human",
              grant: { scope: "once" },
              actor: { kind: auth.actor },
              reason: "a person confirmed this action",
            })
          : undefined
      return {
        action: "send",
        authorizedBy: {
          ...(receipt ? { receiptId: receipt.request.requestId } : {}),
          authority: "human",
          grantScope: "once",
        },
        ...(receipt ? { receipt } : {}),
      }
    }
    case "tool-call": {
      const call = authorizedOutboundToolCall(auth.sessionId, auth.toolUseId, env.now)
      if (call && covers(call, env.target, auth.createdConversation)) {
        return { action: "send", authorizedBy: fromToolCall(call) }
      }
      if (!call && env.mode === "shadow") return { action: "send" }
      return planUnattended(env, {
        ownerRef: `tool-call:${auth.toolUseId}`,
        sessionId: auth.sessionId,
      })
    }
    case "plugin": {
      const fingerprint = outboundFingerprint(env.target)
      const call = runningAuthorizedToolCallsOf(`plugin:${auth.pluginId}`, env.now).find((c) =>
        c.fingerprints.includes(fingerprint)
      )
      if (call) return { action: "send", authorizedBy: fromToolCall(call) }
      return planUnattended(env, { ownerRef: `plugin:${auth.pluginId}` })
    }
    case "unattended":
      return planUnattended(env, auth)
  }
}
