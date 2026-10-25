/**
 * The outbound authorization engine (ADR-0239).
 *
 * `planActionReview` decides whether an outbound action may deliver to its
 * targets, in the ADR's order, first match wins:
 *
 * 1. **Deny.** A ruleset deny, or any target a person refused in this
 *    instruction epoch (the fence). Authority `policy-deny`. With several
 *    targets one fenced target denies the whole action: the action is one
 *    send, and sending it to the others would still deliver what the person
 *    refused to be sent.
 * 2. **Allow.** Every target is authorized: it is the origin thread
 *    (authority `policy-default`), a person allowed it for this instruction
 *    (`human`, grant scope `instruction`) or a person listed it on a Bot or
 *    connector policy (`policy-rule`, grant scope `policy`). Each target is
 *    checked on its own, so a reply into the origin thread that also copies a
 *    granted group is allowed. The result names the narrowest basis used:
 *    an instruction grant, else a policy grant, else the origin thread.
 * 3. **Otherwise** a person decides: `ask` interactively, `draft` for an
 *    unattended connector delivery, `park` for an unattended tool call.
 *
 * What does not authorize a recipient:
 *
 * - A ruleset `allow` or bypass mode. For an outbound tool they only mean the
 *   tool may be used; `verdict` is read for `deny` alone.
 * - A `public` or `unknown` target, for anything but a per-call answer: there
 *   is no recipient a grant could name, and an origin thread is always a
 *   conversation.
 * - The model. `ActionReviewRequest.recommendation` is never read here.
 *
 * Pure: every input is passed in. `plan-context.ts` gathers the context.
 */

import type { PendingOutboundReview } from "@cognia/agent-config-types"
import type {
  ActionReviewAuthority,
  ActionReviewGrant,
  ActionReviewPlan,
  ActionReviewPlanOutcome,
  ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { outboundFingerprint, type OutboundTarget } from "./outbound-targets"

/**
 * - `shadow`: plan and record, change nothing. Every plan carries
 *   `enforced: false` and callers keep their current behavior.
 * - `enforce`: callers act on the plan.
 *
 * The setting that chooses it (`agentPermissions.outboundAuthorization`) is
 * written only by the Settings → Security card, which labels `shadow` "observe
 * only" and asks before switching to `enforce`.
 */
export type OutboundAuthorizationMode = "shadow" | "enforce"

/**
 * The mode `agentPermissions.outboundAuthorization` selects: `enforce` only
 * when it says exactly that, anything else observes. Read structurally so a
 * settings object from any source (the app store, the CLI) can be passed.
 */
export function readOutboundAuthorizationMode(
  settings: { agentPermissions?: unknown } | null | undefined
): OutboundAuthorizationMode {
  const permissions = settings?.agentPermissions
  if (!permissions || typeof permissions !== "object") return "shadow"
  const mode = (permissions as { outboundAuthorization?: unknown }).outboundAuthorization
  return mode === "enforce" ? "enforce" : "shadow"
}

/** The chokepoint asking: a tool call, or a connector delivery. */
export type OutboundReviewVia = "tool" | "delivery"

export interface ActionReviewPlanContext {
  mode: OutboundAuthorizationMode
  /** No person is watching the run (a schedule, a Bot, a background turn). */
  unattended: boolean
  via: OutboundReviewVia
  /** Fingerprints of the conversation the request came from. */
  originFingerprints: ReadonlySet<string>
  /** Fingerprints a person refused in this root session's epoch. */
  fencedFingerprints: ReadonlySet<string>
  /** Fingerprints a person allowed for this root session's epoch. */
  instructionGrants: ReadonlySet<string>
  /** Fingerprint → the configured list that grants it, e.g. `bot:<id>`. */
  policyGrants: ReadonlyMap<string, string>
}

/** The parts of a request the engine reads, plus the targets in full. */
export type ActionReviewPlanInput = Pick<ActionReviewRequest, "verdict"> & {
  /** The action's targets with their kind; the request stores only fingerprints. */
  targets: readonly OutboundTarget[]
}

/** Why a target counts as authorized. */
export type OutboundTargetBasis = "origin" | "instruction" | "policy"

export type ActionReviewPlanReason =
  | "ruleset-deny"
  | "fenced"
  | "authorized"
  | "unauthorized"
  /** The producer could not name a target; never an allow. */
  | "no-target"

export interface ActionReviewPlanResult {
  plan: ActionReviewPlan
  reason: ActionReviewPlanReason
  /** Who decided, for `allow` and `deny`. `ask`, `draft` and `park` wait for a person. */
  authority?: ActionReviewAuthority
  /** The authorization an `allow` rests on, when it is a grant rather than the origin thread. */
  grant?: ActionReviewGrant
  /** Targets the fence refused; non-empty exactly when `reason` is `fenced`. */
  fenced: OutboundTarget[]
  /** Targets nothing authorized, the ones a card or draft has to show. */
  unauthorized: OutboundTarget[]
}

/** Public and unknown targets have no recipient to authorize beyond one call. */
function isGrantable(target: OutboundTarget): boolean {
  return target.kind !== "public" && target.kind !== "unknown"
}

function basisOf(
  target: OutboundTarget,
  fingerprint: string,
  ctx: ActionReviewPlanContext
): OutboundTargetBasis | null {
  if (!isGrantable(target)) return null
  if (target.kind === "conversation" && ctx.originFingerprints.has(fingerprint)) return "origin"
  if (ctx.instructionGrants.has(fingerprint)) return "instruction"
  if (ctx.policyGrants.has(fingerprint)) return "policy"
  return null
}

function pendingOutcome(ctx: ActionReviewPlanContext): ActionReviewPlanOutcome {
  if (!ctx.unattended) return "ask"
  return ctx.via === "delivery" ? "draft" : "park"
}

/** Plan one outbound action. See the module comment for the order. */
export function planActionReview(
  input: ActionReviewPlanInput,
  ctx: ActionReviewPlanContext
): ActionReviewPlanResult {
  const enforced = ctx.mode === "enforce"
  const result = (
    outcome: ActionReviewPlanOutcome,
    rest: Omit<ActionReviewPlanResult, "plan">
  ): ActionReviewPlanResult => ({ plan: { outcome, enforced }, ...rest })

  const fingerprints = input.targets.map((target) => outboundFingerprint(target))

  if (input.verdict === "deny") {
    return result("deny", {
      reason: "ruleset-deny",
      authority: "policy-deny",
      fenced: [],
      unauthorized: [],
    })
  }

  const fenced = input.targets.filter((_, i) => ctx.fencedFingerprints.has(fingerprints[i]))
  if (fenced.length > 0) {
    return result("deny", { reason: "fenced", authority: "policy-deny", fenced, unauthorized: [] })
  }

  if (input.targets.length === 0) {
    return result(pendingOutcome(ctx), { reason: "no-target", fenced: [], unauthorized: [] })
  }

  const bases = input.targets.map((target, i) => basisOf(target, fingerprints[i], ctx))
  const unauthorized = input.targets.filter((_, i) => bases[i] === null)
  if (unauthorized.length > 0) {
    return result(pendingOutcome(ctx), { reason: "unauthorized", fenced: [], unauthorized })
  }

  if (bases.includes("instruction")) {
    return result("allow", {
      reason: "authorized",
      authority: "human",
      grant: { scope: "instruction" },
      fenced: [],
      unauthorized: [],
    })
  }
  const policyIndex = bases.indexOf("policy")
  if (policyIndex >= 0) {
    const policyRef = ctx.policyGrants.get(fingerprints[policyIndex])
    return result("allow", {
      reason: "authorized",
      authority: "policy-rule",
      grant: { scope: "policy", ...(policyRef ? { policyRef } : {}) },
      fenced: [],
      unauthorized: [],
    })
  }
  return result("allow", {
    reason: "authorized",
    authority: "policy-default",
    fenced: [],
    unauthorized: [],
  })
}

/**
 * Whether a person may allow these recipients for the rest of the request:
 * only when there is at least one and every one is named. A public link or a
 * recipient that could not be named is only ever allowed per call. A card
 * offers "allow for this request" exactly when this holds.
 */
export function outboundGrantableForRequest(
  review: Pick<PendingOutboundReview, "targets"> | undefined
): boolean {
  return (
    review !== undefined &&
    review.targets.length > 0 &&
    review.targets.every((target) => target.kind !== "public" && target.kind !== "unknown")
  )
}

/**
 * The grant a person's allow on an outbound card rests on: `instruction` when
 * they allowed it for the rest of the request and every recipient can be
 * granted that long ({@link outboundGrantableForRequest}), else this one call.
 */
export function humanOutboundGrant(
  forRequest: boolean | undefined,
  review?: Pick<PendingOutboundReview, "targets">
): ActionReviewGrant {
  return { scope: forRequest && outboundGrantableForRequest(review) ? "instruction" : "once" }
}
