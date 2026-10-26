/**
 * The integration chokepoint of the outbound policy (ADR-0239 phase 2).
 *
 * Every GitHub write that goes through the host's integration broker is planned
 * here before it happens: an action job (`executeIntegrationAction`) before it
 * is queued, and a raw authenticated request (`authenticatedIntegrationRequest`)
 * that is not a read before it is sent. The caller says who is asking, as an
 * {@link IntegrationAuthorization}; this module checks that claim and, where it
 * does not settle it, asks the engine (`planActionReview`, `via: "tool"`,
 * unattended: an unauthorized write parks for a person rather than drafting).
 *
 * | authorization | checked how                                                          |
 * | ------------- | -------------------------------------------------------------------- |
 * | `tool-call`   | a running, authorized call of the plugin in that session covers it   |
 * | `plugin`      | one of the plugin's running, authorized calls covers it              |
 * | `bot`         | a person approved the Bot's action; else the engine, in the Bot's    |
 * |               | origin, with the event's PR or issue as the origin thread            |
 * | `workflow`    | the engine, in the workflow run's origin                             |
 * | `job`         | a request a running job makes to the repository it was planned for   |
 * | `person`      | a person confirmed the write by hand: proceeds, with a human receipt |
 * | `team-delivery` | a person's "approve and publish"; else the engine, in the request  |
 * |               | of the session that created the team, with its consented repositories |
 *
 * A claim that does not hold is planned as unattended in the asker's origin,
 * so a reply on the PR or issue the request came from still goes; anything
 * else needs a grant or a person. The grants are the asker's own lists (a
 * Bot's, a running handler Bot's) and the ones a person wrote for the
 * account the write goes through (`configuredGithubGrants`): its repository
 * list, and a repository-scoped CapabilityGrant covering the action. A Bot
 * whose writes publish without a person (`decidedBy: "policy"`) may also
 * reach its installation's repository scope (`bot-scope:<id>`).
 *
 * The plan's outcome, as the caller acts on it:
 *
 * - `proceed`: the write goes ahead as it would have without the policy.
 * - `park`: the write waits for a person. A job is held `awaiting_approval`
 *   and pushed to the phone; a synchronous request cannot wait, so it fails.
 * - `deny`: a person refused one of the recipients for the current request
 *   (the fence). The write fails with `outbound_fenced`.
 *
 * Only GitHub writes are planned, in the GitHub category's mode
 * (`agentPermissions.outboundAuthorizationByCategory.github`). Shadow mode
 * changes nothing: a write enforcement would have held or refused proceeds
 * with a receipt saying so.
 *
 * ## Receipts
 *
 * `github-delivery` channel, subject kind `integration-action`, its `ref` the
 * asker (`bot:<id>`, `workflow:<id>`, `plugin:<id>`, `tool-call:<session>`).
 * Enforce mode records every hold and refusal, and every write a grant or a
 * person allowed; shadow mode records only what enforcement would have
 * changed. The recipient itself is never stored: only its fingerprint, and
 * the title names the operation, not the repository.
 */

import {
  type ActionReviewActorKind,
  type ActionReviewAuthority,
  type ActionReviewGrant,
  type ActionReviewOutcome,
  type ActionReviewPlanOutcome,
} from "@cognia/agent-config-types/action-review"
import type { PendingOutboundReview } from "@cognia/agent-config-types"
import type { OutboundJobAuthorization } from "@cognia/plugin-contract/lib/db/connector-types"
import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import type {
  IntegrationActionOutbound,
  IntegrationActionRisk,
} from "@/types/plugin/plugin-integration"

import { runningAuthorizedToolCallsOf } from "./authorized-tool-calls"
import {
  botRecipientGrants,
  botScopeGrants,
  configuredGithubGrants,
  type GithubGrantContext,
} from "./configured-grants"
import {
  outboundFingerprint,
  repositoryOnHost,
  threadNumber,
  toReviewTarget,
  type OutboundTarget,
} from "./outbound-targets"
import {
  botPlanOrigin,
  buildActionReviewPlanContext,
  readAppSettings,
  workflowRunPlanOrigin,
  type ActionReviewPlanOrigin,
  type OutboundPolicyGrantList,
  type OutboundSettingsLike,
} from "./plan-context"
import {
  jobAuthorizationOf,
  outboundReceipt,
  outboundReview,
  type OutboundReceipt,
} from "./outbound-receipt"
import { sessionPlanOrigin } from "./plan-delivery"
import {
  humanOutboundGrant,
  planActionReview,
  readOutboundAuthorizationMode,
  type OutboundAuthorizationMode,
} from "./policy"

/** The Bot installation fields the plan reads. */
export interface IntegrationBotInstallation {
  id: string
  humanRevision?: number
  outboundRecipients?: readonly OutboundRecipientGrant[]
}

/** The part of a Bot event the origin thread is read from. */
export interface IntegrationBotEvent {
  resource?: { kind: string; id: string }
  payload?: unknown
}

/** Who asks for one integration write (ADR-0239 phase 2). */
export type IntegrationAuthorization =
  /**
   * A chat tool of the plugin (`integration__<plugin>__…`), running in
   * `sessionId`. The host's record of the call decides, not the claim.
   */
  | { kind: "tool-call"; pluginId: string; sessionId?: string }
  /** A workflow step: nobody watches it. */
  | { kind: "workflow"; workflowId: string; runId: string }
  /** Plugin code (`ctx.integrations.executeAction` / `authenticatedRequest`). */
  | { kind: "plugin"; pluginId: string }
  /**
   * A Bot's brokered action. `decidedBy` is who approved it: a person on the
   * Bot's approval card, or the installation's policy (automatic publication).
   */
  | {
      kind: "bot"
      installation: IntegrationBotInstallation
      runId: string
      decidedBy: "person" | "policy"
      /** The installation's repository scope (`owner/repo`), when it has one. */
      scopeRepository?: string
    }
  /**
   * A request a running job makes (`context.authenticatedRequest`): the
   * GitHub Issue Loop opening its pull request, a handler's own calls.
   * `covers` is what the job itself was planned for.
   */
  | {
      kind: "job"
      jobId: string
      outbound?: IntegrationActionOutbound
      covers: readonly OutboundTarget[]
    }
  /**
   * A person confirmed this exact write by hand: a dialog that showed the
   * payload, or a button whose label says what it writes (ADR-0239 phase 2).
   * Host-only, like every other claim here: a plugin cannot make it. `surface`
   * names where they clicked (`issue-writeback`, `stack-panel`); it is the
   * receipt's sender. Proceeds, with a human receipt.
   */
  | { kind: "person"; surface: string; sessionId?: string }
  /**
   * An Agent Team publishing its stacked pull requests (`prepareAndPublishGithubStack`).
   * `run`: the team's completed run, nobody watching; `person`: a person's
   * "approve and publish", for this publish or (`forRequest`) the rest of the
   * request. `policyGrants` is the team's consented repositories
   * (`teamDeliveryGrants`). `sessionId` is the session that created the team,
   * whose request the publish belongs to.
   */
  | {
      kind: "team-delivery"
      teamId: string
      runId: string
      sessionId?: string
      decidedBy: "run" | "person"
      forRequest?: boolean
      policyGrants?: readonly OutboundPolicyGrantList[]
    }

export interface IntegrationWritePlanInput {
  /** Where the write lands (`githubActionTargets`, `githubRequestTargets`). */
  targets: readonly OutboundTarget[]
  /** What is written, for the receipt: `github.openPr`, or a request's `POST`. */
  operation: string
  /** The account's GitHub web host (`githubWebHost`), for a Bot event's thread. */
  host?: string
  authorization: IntegrationAuthorization
  /** The integration account the write goes through, for its lists. */
  account?: { pluginId: string; accountId: string }
  /** The broker action the write runs, for a CapabilityGrant. Absent for a raw request. */
  action?: { actionId: string; operationId?: string; risk: IntegrationActionRisk }
}

/** An `integration-action` receipt, for the caller to write. */
export type IntegrationReceipt = OutboundReceipt

export type IntegrationWriteDecision =
  | {
      action: "proceed"
      outbound: IntegrationActionOutbound
      authorizedBy?: OutboundJobAuthorization
      receipt?: IntegrationReceipt
    }
  | {
      action: "park"
      outbound: IntegrationActionOutbound
      /** What the card shows: every recipient, and the ones nothing authorized. */
      review: PendingOutboundReview
      receipt: IntegrationReceipt
    }
  | { action: "deny"; outbound: IntegrationActionOutbound; receipt: IntegrationReceipt }

export interface PlanIntegrationDeps {
  /** App settings, for the mode. Default: the settings store. */
  settings?: () => OutboundSettingsLike | Promise<OutboundSettingsLike>
  /** A session's origin. Default: `sessionPlanOrigin`. */
  resolveSessionOrigin?: (sessionId: string) => Promise<ActionReviewPlanOrigin>
  /** The event a Bot run started from. Default: its delivery's envelope. */
  botRunEvent?: (runId: string) => Promise<IntegrationBotEvent | undefined>
  /** What triggered a workflow run. Default: its `workflowRuns` row. */
  workflowRunTrigger?: (runId: string) => Promise<{ conversationKey?: string } | undefined>
  /** The lists a person wrote for the account. Default: `configuredGithubGrants`. */
  githubGrants?: (context: GithubGrantContext) => Promise<OutboundPolicyGrantList[]>
  /** Test seam for the fence and grant query. */
  listAuthKeys?: (prefix: string, now: number) => Promise<string[]>
  now?: () => number
  newRequestId?: () => string
}

/** The message a fenced write fails with. */
export const OUTBOUND_FENCED_ERROR =
  "outbound_fenced: a person refused this recipient for the current request"

/** The message a synchronous request held by the policy fails with. */
export const OUTBOUND_HELD_REQUEST_ERROR =
  "outbound_held: nothing authorized this recipient, and a direct request cannot wait for a person; use an action so it can be approved"

/**
 * The PR or issue a GitHub event is about, as an origin thread: the event's
 * repository with the payload's `pull_request.number` (else `issue.number`).
 * Undefined for an event about no single PR or issue (a push, a release), or
 * not about a repository at all.
 */
export function botEventOriginThread(
  event: IntegrationBotEvent | undefined,
  host?: string
): OutboundTarget | undefined {
  const resource = event?.resource
  if (!resource || resource.kind !== "repository" || typeof resource.id !== "string") {
    return undefined
  }
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {}
  const numberOf = (key: string) => {
    const value = payload[key]
    return value && typeof value === "object"
      ? threadNumber((value as Record<string, unknown>).number)
      : undefined
  }
  const thread = numberOf("pull_request") ?? numberOf("issue")
  if (!thread) return undefined
  return repositoryOnHost(resource.id, host, thread)
}

/** The recipients an approval card shows for a held write. */
export function integrationOutboundReview(
  targets: readonly OutboundTarget[],
  unauthorized: readonly OutboundTarget[],
  enforced: boolean
): PendingOutboundReview {
  return outboundReview(targets, unauthorized, enforced)
}

interface PlanningEnv {
  input: IntegrationWritePlanInput
  mode: OutboundAuthorizationMode
  settings: OutboundSettingsLike
  now: number
  deps: PlanIntegrationDeps
}

interface ReceiptArgs {
  outbound: IntegrationActionOutbound
  sessionId?: string
  plan: ActionReviewPlanOutcome
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
  actor?: { kind: ActionReviewActorKind }
  reason: string
}

/** One `integration-action` receipt. */
export function integrationReceipt(
  args: ReceiptArgs & {
    targets: readonly OutboundTarget[]
    operation: string
    enforced: boolean
    now: number
    requestId?: string
    /** The integration account the write goes through, for the shadow report's list. */
    account?: IntegrationWritePlanInput["account"]
  }
): IntegrationReceipt {
  const requestId = args.requestId ?? `integration:${crypto.randomUUID()}`
  return outboundReceipt({
    requestId,
    origin: {
      channel: "github-delivery",
      scope: "github",
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      // Nobody is asked at the broker; a held job is answered elsewhere.
      headless: true,
      ...(args.outbound.rootSessionId ? { rootSessionId: args.outbound.rootSessionId } : {}),
      ...(args.outbound.instructionEpoch
        ? { instructionEpoch: args.outbound.instructionEpoch }
        : {}),
    },
    subject: {
      kind: "integration-action",
      ref: args.outbound.ownerRef,
      title: args.operation,
      targets: args.targets.map(toReviewTarget),
      // Ids only, no write input: which account's list would hold these.
      ...(args.account
        ? {
            input: {
              integrationAccount: {
                pluginId: args.account.pluginId,
                accountId: args.account.accountId,
              },
            },
          }
        : {}),
    },
    plan: args.plan,
    enforced: args.enforced,
    outcome: args.outcome,
    authority: args.authority,
    ...(args.grant ? { grant: args.grant } : {}),
    ...(args.actor ? { actor: args.actor } : {}),
    reason: args.reason,
    now: args.now,
  })
}

function receiptFor(env: PlanningEnv, args: ReceiptArgs): IntegrationReceipt {
  return integrationReceipt({
    ...args,
    targets: env.input.targets,
    operation: env.input.operation,
    enforced: env.mode === "enforce",
    now: env.now,
    requestId: `integration:${env.deps.newRequestId?.() ?? crypto.randomUUID()}`,
    ...(env.input.account ? { account: env.input.account } : {}),
  })
}

function coversAll(fingerprints: readonly string[], targets: readonly OutboundTarget[]): boolean {
  return (
    targets.length > 0 &&
    targets.every(
      (target) => target.kind !== "unknown" && fingerprints.includes(outboundFingerprint(target))
    )
  )
}

function outboundOf(ownerRef: string, origin: ActionReviewPlanOrigin): IntegrationActionOutbound {
  return {
    ownerRef,
    ...(origin.rootSessionId ? { rootSessionId: origin.rootSessionId } : {}),
    ...(origin.instructionEpoch ? { instructionEpoch: origin.instructionEpoch } : {}),
  }
}

/**
 * The plan's hold or refusal as the write sees it: held or refused under
 * enforcement, let through and recorded under shadow mode.
 */
function withheld(
  env: PlanningEnv,
  outcome: "park" | "deny",
  args: { outbound: IntegrationActionOutbound; sessionId?: string; unauthorized: OutboundTarget[] }
): IntegrationWriteDecision {
  const what =
    outcome === "park"
      ? "nothing authorized its recipient"
      : "a person refused its recipient for the current request"
  const base = {
    outbound: args.outbound,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  }
  if (env.mode === "shadow") {
    return {
      action: "proceed",
      outbound: args.outbound,
      receipt: receiptFor(env, {
        ...base,
        plan: outcome,
        outcome: "allow",
        authority: "policy-default",
        reason: `written: GitHub outbound authorization is in shadow mode; enforcement would have ${
          outcome === "park" ? "held it for a person" : "refused it"
        } (${what})`,
      }),
    }
  }
  if (outcome === "park") {
    return {
      action: "park",
      outbound: args.outbound,
      review: integrationOutboundReview(env.input.targets, args.unauthorized, true),
      receipt: receiptFor(env, {
        ...base,
        plan: "park",
        outcome: "deny",
        authority: "policy-default",
        reason: `held for a person to approve: ${what}`,
      }),
    }
  }
  return {
    action: "deny",
    outbound: args.outbound,
    receipt: receiptFor(env, {
      ...base,
      plan: "deny",
      outcome: "deny",
      authority: "policy-deny",
      reason: `refused: ${what}`,
    }),
  }
}

/** The lists a person wrote for the write's account, or none without an account. */
async function accountGrants(
  env: PlanningEnv,
  scope: { workflowId?: string; sessionId?: string }
): Promise<OutboundPolicyGrantList[]> {
  const { account, action, host } = env.input
  if (!account) return []
  return (env.deps.githubGrants ?? configuredGithubGrants)({
    account,
    ...(action
      ? {
          operation: {
            ...action,
            ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
            ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          },
        }
      : {}),
    ...(host ? { host } : {}),
  })
}

async function planUnattended(
  env: PlanningEnv,
  unattended: {
    ownerRef: string
    origin?: ActionReviewPlanOrigin
    sessionId?: string
    workflowId?: string
    policyGrants?: readonly OutboundPolicyGrantList[]
  }
): Promise<IntegrationWriteDecision> {
  let origin: ActionReviewPlanOrigin = unattended.origin ?? {}
  let result: ReturnType<typeof planActionReview>
  try {
    if (!unattended.origin && unattended.sessionId) {
      origin = await (env.deps.resolveSessionOrigin ?? sessionPlanOrigin)(unattended.sessionId)
    }
    const policyGrants = [
      ...(unattended.policyGrants ?? []),
      ...(await accountGrants(env, unattended)),
    ]
    const context = await buildActionReviewPlanContext({
      origin,
      unattended: true,
      via: "tool",
      settings: env.settings,
      ...(policyGrants.length > 0 ? { policyGrants } : {}),
      now: env.now,
      ...(env.deps.listAuthKeys ? { listAuthKeys: env.deps.listAuthKeys } : {}),
    })
    result = planActionReview(
      { verdict: "ask", targets: env.input.targets, category: "github" },
      context
    )
  } catch (error) {
    // Shadow mode changes nothing, so a planning failure must not either.
    // Under enforcement nothing was shown to authorize the recipient, so the
    // write waits for a person rather than going out on a failure.
    console.warn("[outbound] integration planning failed", error)
    const outbound = outboundOf(unattended.ownerRef, origin)
    if (env.mode === "shadow") return { action: "proceed", outbound }
    return withheld(env, "park", {
      outbound,
      ...(unattended.sessionId ? { sessionId: unattended.sessionId } : {}),
      unauthorized: [...env.input.targets],
    })
  }
  const outbound = outboundOf(unattended.ownerRef, origin)
  const session = unattended.sessionId ? { sessionId: unattended.sessionId } : {}

  switch (result.plan.outcome) {
    case "allow": {
      const authority = result.authority ?? "policy-default"
      // The origin thread: needs no grant and no receipt.
      if (!result.grant) return { action: "proceed", outbound, authorizedBy: { authority } }
      const receipt =
        env.mode === "enforce"
          ? receiptFor(env, {
              outbound,
              ...session,
              plan: "allow",
              outcome: "allow",
              authority,
              grant: result.grant,
              reason: `allowed by a ${result.grant.scope} grant`,
            })
          : undefined
      return {
        action: "proceed",
        outbound,
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
      return withheld(env, "deny", { outbound, ...session, unauthorized: [] })
    case "ask":
    case "draft":
    case "park":
      return withheld(env, "park", {
        outbound,
        ...session,
        unauthorized: result.unauthorized.length > 0 ? result.unauthorized : [...env.input.targets],
      })
  }
}

async function defaultBotRunEvent(runId: string): Promise<IntegrationBotEvent | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  const delivery = await getDb().botEventDeliveries.where("runId").equals(runId).first()
  return delivery?.envelope
}

async function defaultWorkflowRunTrigger(
  runId: string
): Promise<{ conversationKey?: string } | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  return (await getDb().workflowRuns.get(runId))?.triggeredBy
}

/** Plan one GitHub write. See the module comment for what each authorization means. */
export async function planIntegrationWrite(
  input: IntegrationWritePlanInput,
  deps: PlanIntegrationDeps = {}
): Promise<IntegrationWriteDecision> {
  const settings = await (deps.settings ?? readAppSettings)()
  const env: PlanningEnv = {
    input,
    mode: readOutboundAuthorizationMode(settings, "github"),
    settings,
    now: deps.now?.() ?? Date.now(),
    deps,
  }
  const auth = input.authorization

  switch (auth.kind) {
    case "tool-call": {
      const ownerRef = `tool-call:${auth.sessionId ?? auth.pluginId}`
      const calls = runningAuthorizedToolCallsOf(`plugin:${auth.pluginId}`, env.now).filter(
        (call) => !auth.sessionId || call.sessionId === auth.sessionId
      )
      const call = calls.find((c) => coversAll(c.fingerprints, input.targets))
      if (call) {
        const origin = auth.sessionId
          ? await (deps.resolveSessionOrigin ?? sessionPlanOrigin)(auth.sessionId).catch(() => ({}))
          : {}
        return {
          action: "proceed",
          outbound: outboundOf(ownerRef, origin),
          authorizedBy: jobAuthorizationOf(call),
        }
      }
      // In shadow mode a permission shortcut can answer the call without
      // asking, so a missing record says nothing about what enforcement does.
      if (calls.length === 0 && env.mode === "shadow") {
        return { action: "proceed", outbound: { ownerRef } }
      }
      return planUnattended(env, {
        ownerRef,
        ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
      })
    }
    case "plugin": {
      const call = runningAuthorizedToolCallsOf(`plugin:${auth.pluginId}`, env.now).find((c) =>
        coversAll(c.fingerprints, input.targets)
      )
      const ownerRef = `plugin:${auth.pluginId}`
      if (call) {
        return { action: "proceed", outbound: { ownerRef }, authorizedBy: jobAuthorizationOf(call) }
      }
      // A handler Bot's write names its run through the action's `binding`
      // (the `bot` authorization); the plugin's own code borrows no list.
      return planUnattended(env, { ownerRef })
    }
    case "bot": {
      const ownerRef = `bot:${auth.installation.id}`
      const event = await (deps.botRunEvent ?? defaultBotRunEvent)(auth.runId).catch(
        () => undefined
      )
      const originThread = botEventOriginThread(event, input.host)
      const origin: ActionReviewPlanOrigin = {
        ...botPlanOrigin(auth.installation),
        ...(originThread ? { originThread } : {}),
      }
      if (auth.decidedBy === "person") {
        const outbound = outboundOf(ownerRef, origin)
        const receipt =
          env.mode === "enforce"
            ? receiptFor(env, {
                outbound,
                plan: "allow",
                outcome: "allow",
                authority: "human",
                grant: { scope: "once" },
                actor: { kind: "local-user" },
                reason: "a person approved this Bot action",
              })
            : undefined
        return {
          action: "proceed",
          outbound,
          authorizedBy: {
            ...(receipt ? { receiptId: receipt.request.requestId } : {}),
            authority: "human",
            grantScope: "once",
          },
          ...(receipt ? { receipt } : {}),
        }
      }
      return planUnattended(env, {
        ownerRef,
        origin,
        policyGrants: [
          ...botRecipientGrants(auth.installation),
          ...botScopeGrants(auth.installation, auth.scopeRepository, input.host),
        ],
      })
    }
    case "workflow": {
      const trigger = await (deps.workflowRunTrigger ?? defaultWorkflowRunTrigger)(
        auth.runId
      ).catch(() => undefined)
      return planUnattended(env, {
        ownerRef: `workflow:${auth.workflowId}`,
        workflowId: auth.workflowId,
        origin: workflowRunPlanOrigin({
          id: auth.runId,
          ...(trigger ? { triggeredBy: trigger } : {}),
        }),
      })
    }
    case "person": {
      const origin = auth.sessionId
        ? await (deps.resolveSessionOrigin ?? sessionPlanOrigin)(auth.sessionId).catch(() => ({}))
        : {}
      const outbound = outboundOf(`person:${auth.surface}`, origin)
      const receipt = receiptFor(env, {
        outbound,
        ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
        plan: "allow",
        outcome: "allow",
        authority: "human",
        grant: { scope: "once" },
        actor: { kind: "local-user" },
        reason: "a person confirmed this write by hand",
      })
      return {
        action: "proceed",
        outbound,
        authorizedBy: {
          receiptId: receipt.request.requestId,
          authority: "human",
          grantScope: "once",
        },
        receipt,
      }
    }
    case "team-delivery": {
      const ownerRef = `agent-team:${auth.teamId}`
      if (auth.decidedBy === "person") {
        const origin = await teamDeliveryOrigin(auth, deps)
        const outbound = outboundOf(ownerRef, origin)
        const receipt = heldJobAnswerReceipt({
          outbound,
          targets: input.targets,
          operation: input.operation,
          answer: "approved",
          ...(auth.forRequest ? { forRequest: true } : {}),
          now: env.now,
        })
        return {
          action: "proceed",
          outbound,
          authorizedBy: {
            receiptId: receipt.request.requestId,
            authority: "human",
            ...(receipt.decision.grant ? { grantScope: receipt.decision.grant.scope } : {}),
          },
          receipt,
        }
      }
      // The publisher names no integration account, so every GitHub
      // account's list counts, as for a `gh` command.
      const accountLists = await (deps.githubGrants ?? configuredGithubGrants)(
        input.host ? { host: input.host } : {}
      ).catch(() => [] as OutboundPolicyGrantList[])
      return planUnattended(env, {
        ownerRef,
        origin: await teamDeliveryOrigin(auth, deps),
        policyGrants: [...(auth.policyGrants ?? []), ...accountLists],
      })
    }
    case "job": {
      const ownerRef = auth.outbound?.ownerRef ?? `integration-job:${auth.jobId}`
      const covered = auth.covers.map((target) => outboundFingerprint(target))
      if (coversAll(covered, input.targets)) {
        return { action: "proceed", outbound: auth.outbound ?? { ownerRef } }
      }
      // Anything else is planned in the job's own origin, with the PR or issue
      // it works on as the origin thread (the Issue Loop's issue).
      const originThread = auth.covers.find((target) => target.thread)
      return planUnattended(env, {
        ownerRef,
        origin: {
          ...(auth.outbound?.rootSessionId ? { rootSessionId: auth.outbound.rootSessionId } : {}),
          ...(auth.outbound?.instructionEpoch
            ? { instructionEpoch: auth.outbound.instructionEpoch }
            : {}),
          ...(originThread ? { originThread } : {}),
        },
      })
    }
  }
}

/**
 * The request an Agent Team's publish belongs to: that of the session that
 * created the team, else one of its own per run.
 */
export async function teamDeliveryOrigin(
  team: { runId: string; sessionId?: string },
  deps: Pick<PlanIntegrationDeps, "resolveSessionOrigin"> = {}
): Promise<ActionReviewPlanOrigin> {
  const own = {
    rootSessionId: `agent-team-run:${team.runId}`,
    instructionEpoch: `agent-team-run:${team.runId}`,
  }
  if (!team.sessionId) return own
  try {
    const origin = await (deps.resolveSessionOrigin ?? sessionPlanOrigin)(team.sessionId)
    // The team's publish answers the request; the chat it came from is not
    // where the pull requests go.
    return origin.rootSessionId && origin.instructionEpoch
      ? { rootSessionId: origin.rootSessionId, instructionEpoch: origin.instructionEpoch }
      : own
  } catch {
    return own
  }
}

/** The outbound record of an Agent Team's publish, for a person's answer to it. */
export async function teamDeliveryOutbound(
  team: { teamId: string; runId: string; sessionId?: string },
  deps: Pick<PlanIntegrationDeps, "resolveSessionOrigin"> = {}
): Promise<IntegrationActionOutbound> {
  return outboundOf(`agent-team:${team.teamId}`, await teamDeliveryOrigin(team, deps))
}

/**
 * The receipt of a person's answer to a held job: an approval (for this one
 * write, or for the rest of the request when `forRequest` and every
 * recipient can be granted that long), or a refusal, which fences the
 * recipients for the rest of the request.
 */
export function heldJobAnswerReceipt(args: {
  outbound: IntegrationActionOutbound
  targets: readonly OutboundTarget[]
  operation: string
  answer: "approved" | "denied"
  forRequest?: boolean
  actor?: ActionReviewActorKind
  now?: number
}): IntegrationReceipt {
  const approved = args.answer === "approved"
  return integrationReceipt({
    outbound: args.outbound,
    targets: args.targets,
    operation: args.operation,
    enforced: true,
    now: args.now ?? Date.now(),
    plan: "park",
    outcome: approved ? "allow" : "deny",
    authority: "human",
    ...(approved
      ? {
          grant: humanOutboundGrant(args.forRequest, {
            targets: integrationOutboundReview(args.targets, [], true).targets,
          }),
        }
      : {}),
    actor: { kind: args.actor ?? "local-user" },
    reason: approved ? "a person approved the held write" : "a person refused the held write",
  })
}
