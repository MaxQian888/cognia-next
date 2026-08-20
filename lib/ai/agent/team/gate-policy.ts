/**
 * Headless HITL gate policy for team runs.
 *
 * `runTeamLifecycle` has six approval gates that block on `waitForDecision`
 * (capability-audit, plan-approval, deadlock, budget, teammate-fix, replan).
 * Interactive runs surface them through the pending-gates UI, but headless
 * surfaces — scheduler, remote-control, external bridge, plugin SDK, IM,
 * team→team delegation — have no operator watching a modal, so a gated run
 * used to hang forever. This module maps each gate × run-origin to an
 * explicit behavior:
 *
 *  - `block`        — wait for the operator (interactive default).
 *  - `auto-approve` — proceed as if approved. Only safe where approval merely
 *                     acknowledges degradation (capability-audit: stale ids
 *                     simply don't resolve).
 *  - `auto-reject`  — resolve as rejected where reject is already fail-open
 *                     (teammate-fix: run continues on the remaining workers;
 *                     replan: the original plan proceeds).
 *  - `fail-fast`    — the caller must abort/fail the run instead of waiting
 *                     (plan approval without a human is meaningless; deadlock
 *                     and budget block indefinitely by design).
 *  - `delegate`     — ask the human through a channel the caller supplies.
 *                     For the origins that HAVE one, `fail-fast`'s premise —
 *                     "there is no human" — is simply false.
 *
 * That last one exists because "headless" was doing two jobs. A scheduler run
 * at 3am really has nobody watching. An IM run has a person on the other end of
 * the thread AND a working approval channel: `makeImPermissionResponder`
 * already suspends a turn on an A2UI Allow/Deny card with a TTL, an actor-scope
 * guard, and a durable `ExecutionRunInterrupt`. Treating the two the same meant
 * an IM-triggered team run whose plan tripped the risk gate failed loudly
 * instead of asking the question it had every means to ask.
 */

import type { ApprovalDecision } from "@/lib/runtime/approval-bus"
import type { TeamRunOrigin } from "@/types/agent/agent-team"

/**
 * Canonical definition lives in `types/agent/agent-team.ts` so `types/`
 * consumers (plugin SDK options, manager interfaces) never import `lib/`.
 * Re-exported here as the policy module's natural home.
 */
export type { TeamRunOrigin }

export type GateBehavior = "block" | "auto-approve" | "auto-reject" | "fail-fast" | "delegate"

export interface TeamGatePolicy {
  capabilityAudit: GateBehavior
  planApproval: GateBehavior
  deadlock: GateBehavior
  budget: GateBehavior
  teammateFix: GateBehavior
  replan: GateBehavior
}

export function isHeadlessOrigin(origin: TeamRunOrigin | undefined): boolean {
  return origin !== undefined && origin !== "interactive"
}

export interface ResolveGatePolicyOptions {
  /**
   * The caller can reach a human through this run's own surface and has a
   * delegate to do it with.
   *
   * Default `false` so every existing caller — and every existing test — keeps
   * today's behaviour byte for byte. Only a caller that PROVES it has a channel
   * gets the attended policy; claiming one it cannot service would turn a loud
   * failure into a silent hang, which is strictly worse.
   */
  approvalChannel?: boolean
}

const INTERACTIVE_POLICY: TeamGatePolicy = {
  capabilityAudit: "block",
  planApproval: "block",
  deadlock: "block",
  budget: "block",
  teammateFix: "block",
  replan: "block",
}

const HEADLESS_POLICY: TeamGatePolicy = {
  // Stale capability ids only degrade (they don't resolve) — warn + proceed.
  capabilityAudit: "auto-approve",
  // requirePlanApproval defaults to false, so `true` was an explicit operator
  // choice — failing fast (before burning planning tokens) is honest;
  // auto-approving would silently void the operator's gate.
  planApproval: "fail-fast",
  // These block indefinitely by design; aborting beats hanging headless.
  deadlock: "fail-fast",
  budget: "fail-fast",
  // Reject is already fail-open: the run continues on the remaining workers.
  teammateFix: "auto-reject",
  // Reject is fail-open: the original plan proceeds (replan-gate.ts:49-52).
  replan: "auto-reject",
}

/**
 * Headless, but with a human reachable on the run's own surface.
 *
 * Only `planApproval` moves. Deadlock and budget stay `fail-fast` because they
 * block indefinitely by design — handing them to a card would park a run on a
 * question no answer can unblock. Capability-audit stays `auto-approve`
 * (stale ids only degrade) and the two fail-open gates stay `auto-reject`.
 */
const ATTENDED_HEADLESS_POLICY: TeamGatePolicy = {
  ...HEADLESS_POLICY,
  planApproval: "delegate",
}

/** Resolve the gate policy for a run origin. Undefined → interactive. */
export function resolveGatePolicy(
  origin: TeamRunOrigin | undefined,
  options: ResolveGatePolicyOptions = {}
): TeamGatePolicy {
  if (!isHeadlessOrigin(origin)) return INTERACTIVE_POLICY
  return options.approvalChannel ? ATTENDED_HEADLESS_POLICY : HEADLESS_POLICY
}

export interface ApplyGateOptions {
  /**
   * Optional cap on a `block` wait. On expiry the gate resolves with
   * `fallback` (default `fail-fast`). Off by default — enabling it is an
   * explicit caller decision, not a policy default.
   */
  timeoutMs?: number
  fallback?: Exclude<GateBehavior, "block" | "delegate">
  /**
   * Asks the human through the run's own surface. Required by the `delegate`
   * behaviour; its absence falls back to `fail-fast` rather than proceeding,
   * matching this module's fail-closed posture everywhere else.
   */
  delegate?: () => Promise<ApprovalDecision>
}

function resolveNonBlocking(
  behavior: Exclude<GateBehavior, "block" | "delegate">
): ApprovalDecision {
  return behavior === "auto-approve"
    ? { outcome: "approve" }
    : { outcome: "reject", feedback: `headless-policy:${behavior}` }
}

/**
 * Apply a gate behavior: non-blocking behaviors resolve immediately without
 * registering a waiter; `block` awaits `wait()` (optionally raced against
 * `timeoutMs`, with the timer cleaned up on settle).
 */
export async function applyGateBehavior(
  behavior: GateBehavior,
  wait: () => Promise<ApprovalDecision>,
  opts: ApplyGateOptions = {}
): Promise<ApprovalDecision> {
  if (behavior === "delegate") {
    // Fail closed: a policy that asked for a question the caller cannot ask
    // must not become "proceed", and must not hang either.
    if (!opts.delegate) return resolveNonBlocking("fail-fast")
    try {
      return await opts.delegate()
    } catch {
      return resolveNonBlocking("fail-fast")
    }
  }
  if (behavior !== "block") return resolveNonBlocking(behavior)
  if (!opts.timeoutMs) return wait()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      wait(),
      new Promise<ApprovalDecision>((resolve) => {
        timer = setTimeout(
          () => resolve(resolveNonBlocking(opts.fallback ?? "fail-fast")),
          opts.timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
