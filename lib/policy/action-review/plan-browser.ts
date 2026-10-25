/**
 * The browser chokepoint of the outbound policy (ADR-0239 phase 2b).
 *
 * What an agent's browser action sends to a site is planned here, in the
 * browser category's mode (`agentPermissions.outboundAuthorizationByCategory.browser`):
 *
 * - `request`: a submission a Chromium runtime held or observed (a request
 *   that carries data, a WebSocket frame), planned against the site it goes
 *   to (`services/workspace-runtime/src/submission-guard.mjs`);
 * - `possible`: an action that may submit on an engine with no submission
 *   signal (the embedded webview, the extension, or a page a service worker
 *   controls in the person's own Chrome), planned before it runs against the
 *   page's own site.
 *
 * The recipient is the site's origin ({@link submissionSiteTarget}); a site
 * is never an origin thread, so a submission is allowed only by a list a
 * person wrote (the global site list `agentPermissions.outboundSites`, a
 * Bot installation's sites) or by a person's "allow for this request".
 *
 * | asker             | who is asked                                         | origin                     |
 * | ----------------- | ---------------------------------------------------- | -------------------------- |
 * | `chat`            | the person at this computer (the outbound dialog)    | the session's request      |
 * | `turn`            | the run's own approval path, or a parked approval    | the run's (task, Bot, …)   |
 * | `workflow`        | a parked approval                                    | the workflow run           |
 * | `external-bridge` | the person at this computer (the outbound dialog)    | none: allow once or refuse |
 * | `plugin`          | a parked approval                                    | none                       |
 *
 * The outcome:
 *
 * - `proceed`: the submission goes out.
 * - `ask`: a person decides; the caller asks them and records their answer
 *   with {@link browserSubmissionAnswerReceipt}. A refusal fences the site for
 *   the rest of the request; nobody answering refuses this one submission only.
 * - `refuse`: a person refused the site earlier in this request (the fence).
 *
 * Shadow mode changes nothing: every submission proceeds, and one enforcement
 * would have asked about or refused gets a receipt saying so.
 *
 * ## Receipts
 *
 * `browser-submission` channel, subject kind `browser-submission`, its `ref`
 * the asker (`browser:<session>`, `workflow:<id>`, `plugin:<id>`,
 * `external-bridge:<client>`). The site is stored only as its fingerprint;
 * the title names the operation (`POST`, `WS`, `click`), never the URL.
 */

import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewActorKind,
  type ActionReviewAuthority,
  type ActionReviewDecision,
  type ActionReviewGrant,
  type ActionReviewOutcome,
  type ActionReviewPlanOutcome,
  type ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import type { PendingOutboundReview } from "@cognia/agent-config-types"

import { classifyRisk } from "@/lib/policy/risk/classify-risk"

import { configuredSiteGrants, runningBotGrantsOf } from "./configured-grants"
import {
  siteTarget,
  toReviewTarget,
  unknownSiteTarget,
  type OutboundTarget,
} from "./outbound-targets"
import {
  buildActionReviewPlanContext,
  readAppSettings,
  workflowRunPlanOrigin,
  type ActionReviewPlanOrigin,
  type OutboundPolicyGrantList,
  type OutboundSettingsLike,
} from "./plan-context"
import { sessionPlanOrigin } from "./plan-delivery"
import {
  humanOutboundGrant,
  outboundGrantableForRequest,
  planActionReview,
  readOutboundAuthorizationMode,
  type OutboundAuthorizationMode,
} from "./policy"

/** Who drives the browser action a submission comes from. */
export type BrowserSubmissionAsker =
  /** The built-in browser tools in a desktop chat a person is driving. */
  | { kind: "chat"; sessionId: string }
  /**
   * The built-in browser tools in a turn a runner drives (a scheduled task, a
   * Bot, an IM reply): its own planning options, as `run-and-capture` holds
   * them for the turn's other outbound calls.
   */
  | {
      kind: "turn"
      sessionId: string
      unattended: boolean
      origin?: ActionReviewPlanOrigin | (() => Promise<ActionReviewPlanOrigin>)
      policyGrants?: readonly OutboundPolicyGrantList[]
    }
  /** A workflow run's browser node: nobody watches it. */
  | { kind: "workflow"; workflowId: string; runId: string }
  /** An External Bridge client driving the browser tools from this computer. */
  | { kind: "external-bridge"; clientId: string }
  /** Another plugin's own browser use. */
  | { kind: "plugin"; pluginId: string }

export interface BrowserSubmissionPlanInput {
  /** The request URL (`request`), or the page URL the action runs on (`possible`). */
  url: string
  basis: "request" | "possible"
  /** For the receipt title: the request method (`POST`, `WS`), or the action (`click`). */
  operation: string
  asker: BrowserSubmissionAsker
}

/** A `browser-submission` receipt, for the caller to write. */
export interface BrowserSubmissionReceipt {
  request: ActionReviewRequest
  decision: ActionReviewDecision
}

/** What a person is asked about one submission. */
export interface BrowserSubmissionAsk {
  /** Nobody is at this computer for this run: ask through the run's approval path. */
  unattended: boolean
  /** The site, as the dialog shows it. */
  target: OutboundTarget
  review: PendingOutboundReview
  /** "Allow for this request" can be offered: the site is named and the run has a request. */
  forRequestOffered: boolean
  basis: BrowserSubmissionPlanInput["basis"]
  operation: string
  ownerRef: string
  sessionId?: string
  origin: ActionReviewPlanOrigin
}

export type BrowserSubmissionDecision =
  | { action: "proceed"; receipt?: BrowserSubmissionReceipt }
  | { action: "ask"; ask: BrowserSubmissionAsk }
  | { action: "refuse"; receipt: BrowserSubmissionReceipt }

export interface PlanBrowserDeps {
  /** App settings, for the mode and the global site list. Default: the settings store. */
  settings?: () => OutboundSettingsLike | Promise<OutboundSettingsLike>
  /** A session's origin. Default: `sessionPlanOrigin`. */
  resolveSessionOrigin?: (sessionId: string) => Promise<ActionReviewPlanOrigin>
  /** What triggered a workflow run. Default: its `workflowRuns` row. */
  workflowRunTrigger?: (runId: string) => Promise<{ conversationKey?: string } | undefined>
  /** Test seam for the fence and grant query. */
  listAuthKeys?: (prefix: string, now: number) => Promise<string[]>
  now?: () => number
  newRequestId?: () => string
}

/** The message a refused submission fails with, for the agent. */
export const BROWSER_SUBMISSION_REFUSED_ERROR =
  "outbound_refused: the outbound policy refused what this action sends to that site"

/**
 * The site a submission reaches: the origin of an `http(s)` URL, a WebSocket
 * counting as its `http(s)` site so one list entry covers both. A URL with no
 * site (a `data:` page, an extension page) is an unknown browser recipient,
 * which only a per-call answer can allow.
 */
export function submissionSiteTarget(url: string): OutboundTarget {
  let normalized = url.trim()
  if (/^wss:/i.test(normalized)) normalized = `https:${normalized.slice(4)}`
  else if (/^ws:/i.test(normalized)) normalized = `http:${normalized.slice(3)}`
  return siteTarget(normalized) ?? unknownSiteTarget()
}

/** The asker's receipt ref. */
export function browserAskerRef(asker: BrowserSubmissionAsker): string {
  switch (asker.kind) {
    case "chat":
    case "turn":
      return `browser:${asker.sessionId}`
    case "workflow":
      return `workflow:${asker.workflowId}`
    case "external-bridge":
      return `external-bridge:${asker.clientId}`
    case "plugin":
      return `plugin:${asker.pluginId}`
  }
}

function askerSessionId(asker: BrowserSubmissionAsker): string | undefined {
  return asker.kind === "chat" || asker.kind === "turn" ? asker.sessionId : undefined
}

/** One `browser-submission` receipt. */
export function browserSubmissionReceipt(args: {
  target: OutboundTarget
  operation: string
  ownerRef: string
  sessionId?: string
  origin: ActionReviewPlanOrigin
  unattended: boolean
  plan: ActionReviewPlanOutcome
  enforced: boolean
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
  actor?: ActionReviewActorKind
  reason: string
  now: number
  requestId?: string
}): BrowserSubmissionReceipt {
  const requestId = args.requestId ?? `browser-submission:${crypto.randomUUID()}`
  const risk = classifyRisk({
    objective: "",
    taskDescriptions: [],
    toolIds: ["connector_send"],
    capabilityIds: [],
    sandboxEnabled: false,
  })
  const permits = args.outcome === "allow" || args.outcome === "allow_always"
  return {
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId,
      origin: {
        channel: "browser-submission",
        scope: "browser",
        id: requestId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.unattended ? { headless: true } : {}),
        ...(args.origin.rootSessionId ? { rootSessionId: args.origin.rootSessionId } : {}),
        ...(args.origin.instructionEpoch ? { instructionEpoch: args.origin.instructionEpoch } : {}),
      },
      subject: {
        kind: "browser-submission",
        ref: args.ownerRef,
        title: args.operation,
        targets: [toReviewTarget(args.target)],
      },
      verdict: "ask",
      verdictExplicit: false,
      tier: risk.tier,
      surfaces: risk.surfaces,
      plan: { outcome: args.plan, enforced: args.enforced },
      requestedAt: args.now,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId,
      outcome: args.outcome,
      authority: args.authority,
      reason: args.reason,
      ...(args.grant && permits ? { grant: args.grant } : {}),
      ...(args.actor ? { actor: { kind: args.actor } } : {}),
      decidedAt: args.now,
    },
  }
}

async function defaultWorkflowRunTrigger(
  runId: string
): Promise<{ conversationKey?: string } | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  return (await getDb().workflowRuns.get(runId))?.triggeredBy
}

interface AskerPlan {
  origin: ActionReviewPlanOrigin
  unattended: boolean
  policyGrants: OutboundPolicyGrantList[]
}

async function askerPlan(asker: BrowserSubmissionAsker, deps: PlanBrowserDeps): Promise<AskerPlan> {
  const sessionOrigin = (sessionId: string) =>
    (deps.resolveSessionOrigin ?? sessionPlanOrigin)(sessionId)
  switch (asker.kind) {
    case "chat":
      return { origin: await sessionOrigin(asker.sessionId), unattended: false, policyGrants: [] }
    case "turn": {
      const origin =
        typeof asker.origin === "function"
          ? await asker.origin()
          : (asker.origin ?? (await sessionOrigin(asker.sessionId)))
      return {
        origin,
        unattended: asker.unattended,
        policyGrants: [...(asker.policyGrants ?? [])],
      }
    }
    case "workflow": {
      const trigger = await (deps.workflowRunTrigger ?? defaultWorkflowRunTrigger)(
        asker.runId
      ).catch(() => undefined)
      return {
        origin: workflowRunPlanOrigin({
          id: asker.runId,
          ...(trigger ? { triggeredBy: trigger } : {}),
        }),
        unattended: true,
        policyGrants: [],
      }
    }
    case "external-bridge":
      // A bridge client has no request to scope a grant or a fence to: each
      // submission is allowed once or refused.
      return { origin: {}, unattended: false, policyGrants: [] }
    case "plugin":
      // A handler Bot of this plugin that is running may reach its sites.
      return { origin: {}, unattended: true, policyGrants: runningBotGrantsOf(asker.pluginId) }
  }
}

/** Plan one browser submission. See the module comment. */
export async function planBrowserSubmission(
  input: BrowserSubmissionPlanInput,
  deps: PlanBrowserDeps = {}
): Promise<BrowserSubmissionDecision> {
  const settings = await (deps.settings ?? readAppSettings)()
  const mode: OutboundAuthorizationMode = readOutboundAuthorizationMode(settings, "browser")
  const now = deps.now?.() ?? Date.now()
  const target = submissionSiteTarget(input.url)
  const ownerRef = browserAskerRef(input.asker)
  const sessionId = askerSessionId(input.asker)
  const requestId = () => `browser-submission:${deps.newRequestId?.() ?? crypto.randomUUID()}`

  let planned: AskerPlan
  let result: ReturnType<typeof planActionReview>
  try {
    planned = await askerPlan(input.asker, deps)
    const policyGrants = [...configuredSiteGrants(settings), ...planned.policyGrants]
    const context = await buildActionReviewPlanContext({
      origin: planned.origin,
      unattended: planned.unattended,
      via: "tool",
      settings,
      ...(policyGrants.length > 0 ? { policyGrants } : {}),
      now,
      ...(deps.listAuthKeys ? { listAuthKeys: deps.listAuthKeys } : {}),
    })
    result = planActionReview({ verdict: "ask", targets: [target], category: "browser" }, context)
  } catch (error) {
    // Shadow mode changes nothing, so a planning failure must not either.
    // Under enforcement nothing authorized the site, so a person decides.
    console.warn("[outbound] browser submission planning failed", error)
    if (mode === "shadow") return { action: "proceed" }
    const unattended = input.asker.kind !== "chat" && input.asker.kind !== "external-bridge"
    return {
      action: "ask",
      ask: askOf({ input, target, ownerRef, sessionId, origin: {}, unattended }),
    }
  }

  const receipt = (
    rest: Pick<
      Parameters<typeof browserSubmissionReceipt>[0],
      "plan" | "outcome" | "authority" | "grant" | "reason"
    >
  ) =>
    browserSubmissionReceipt({
      target,
      operation: input.operation,
      ownerRef,
      ...(sessionId ? { sessionId } : {}),
      origin: planned.origin,
      unattended: planned.unattended,
      enforced: mode === "enforce",
      now,
      requestId: requestId(),
      ...rest,
    })

  switch (result.plan.outcome) {
    case "allow": {
      if (mode === "shadow") return { action: "proceed" }
      const authority = result.authority ?? "policy-default"
      return {
        action: "proceed",
        receipt: receipt({
          plan: "allow",
          outcome: "allow",
          authority,
          ...(result.grant ? { grant: result.grant } : {}),
          reason: result.grant
            ? `allowed by a ${result.grant.scope} grant`
            : "allowed by the outbound policy",
        }),
      }
    }
    case "deny": {
      const what = "a person refused this site for the current request"
      if (mode === "shadow") {
        return {
          action: "proceed",
          receipt: receipt({
            plan: "deny",
            outcome: "allow",
            authority: "policy-default",
            reason: `sent: browser outbound authorization is in shadow mode; enforcement would have refused it (${what})`,
          }),
        }
      }
      return {
        action: "refuse",
        receipt: receipt({
          plan: "deny",
          outcome: "deny",
          authority: "policy-deny",
          reason: `refused: ${what}`,
        }),
      }
    }
    case "ask":
    case "draft":
    case "park": {
      if (mode === "shadow") {
        return {
          action: "proceed",
          receipt: receipt({
            plan: result.plan.outcome,
            outcome: "allow",
            authority: "policy-default",
            reason: `sent: browser outbound authorization is in shadow mode; enforcement would have ${
              result.plan.outcome === "ask" ? "asked a person" : "held it for a person"
            } (nothing authorized this site)`,
          }),
        }
      }
      return {
        action: "ask",
        ask: askOf({
          input,
          target,
          ownerRef,
          sessionId,
          origin: planned.origin,
          unattended: planned.unattended,
        }),
      }
    }
  }
}

function askOf(args: {
  input: BrowserSubmissionPlanInput
  target: OutboundTarget
  ownerRef: string
  sessionId: string | undefined
  origin: ActionReviewPlanOrigin
  unattended: boolean
}): BrowserSubmissionAsk {
  const view = {
    kind: args.target.kind,
    channel: args.target.channel,
    recipient: args.target.recipient,
  }
  const review: PendingOutboundReview = { targets: [view], unauthorized: [view], enforced: true }
  return {
    unattended: args.unattended,
    target: args.target,
    review,
    forRequestOffered:
      outboundGrantableForRequest(review) &&
      Boolean(args.origin.rootSessionId && args.origin.instructionEpoch),
    basis: args.input.basis,
    operation: args.input.operation,
    ownerRef: args.ownerRef,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    origin: args.origin,
  }
}

/** What became of a question about one submission. */
export type BrowserSubmissionAnswer =
  /** A person allowed it: this once, or (`forRequest`) the site for the rest of the request. */
  | { kind: "allowed"; forRequest?: boolean; actor?: ActionReviewActorKind }
  /** A person refused it: the site is fenced for the rest of the request. */
  | { kind: "refused"; actor?: ActionReviewActorKind }
  /** Nobody answered in time. Refuses this submission only. */
  | { kind: "expired" }
  /** Nobody could be asked (the run ended, no approval path). Refuses this submission only. */
  | { kind: "unavailable"; reason: string }

/** The receipt of a person's answer, or of nobody answering. */
export function browserSubmissionAnswerReceipt(
  ask: BrowserSubmissionAsk,
  answer: BrowserSubmissionAnswer,
  now: number = Date.now()
): BrowserSubmissionReceipt {
  const base = {
    target: ask.target,
    operation: ask.operation,
    ownerRef: ask.ownerRef,
    ...(ask.sessionId ? { sessionId: ask.sessionId } : {}),
    origin: ask.origin,
    unattended: ask.unattended,
    plan: (ask.unattended ? "park" : "ask") as ActionReviewPlanOutcome,
    enforced: true,
    now,
  }
  switch (answer.kind) {
    case "allowed":
      return browserSubmissionReceipt({
        ...base,
        outcome: "allow",
        authority: "human",
        grant: humanOutboundGrant(answer.forRequest && ask.forRequestOffered, ask.review),
        actor: answer.actor ?? "local-user",
        reason: "a person allowed the submission",
      })
    case "refused":
      return browserSubmissionReceipt({
        ...base,
        outcome: "deny",
        authority: "human",
        actor: answer.actor ?? "local-user",
        reason: "a person refused the submission",
      })
    case "expired":
      return browserSubmissionReceipt({
        ...base,
        outcome: "expired",
        authority: "timeout",
        reason: "nobody answered in time; refused this submission",
      })
    case "unavailable":
      return browserSubmissionReceipt({
        ...base,
        outcome: "deny",
        authority: "system",
        reason: `nobody could be asked (${answer.reason}); refused this submission`,
      })
  }
}
