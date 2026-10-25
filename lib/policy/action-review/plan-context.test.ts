/** @jest-environment jsdom */

import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewReceipt,
} from "@cognia/agent-config-types/action-review"

import {
  __clearAllSubagentApprovalRoutesForTesting,
  registerSubagentApprovalRoute,
} from "@/lib/claude/agents/subagent-approval-routes"
import { subSessionId } from "@/lib/claude/team-session-id"
import { recordActionReviewReceipt } from "@/lib/db/action-review-receipts"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import {
  conversationTarget,
  originMatchFingerprint,
  outboundFingerprint,
  repositoryTarget,
  toReviewTarget,
} from "./outbound-targets"
import {
  botPlanOrigin,
  buildActionReviewPlanContext,
  taskPlanOrigin,
  type ActionReviewPlanOrigin,
} from "./plan-context"
import { planActionReview, readOutboundAuthorizationMode } from "./policy"
import {
  __clearRequestOriginCacheForTesting,
  resolveSessionRequestOrigin,
} from "./resolve-request-origin"

jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  getSharedRunRequester: () => undefined,
}))

const NOW = 1_000_000
const GROUP = conversationTarget("lark:bot-a:oc_group")!
const THREAD = conversationTarget("lark:bot-a:oc_thread")!

let seq = 0
async function receipt(opts: {
  root: string
  epoch: string
  outcome: ActionReviewReceipt["decision"]["outcome"]
  authority: ActionReviewReceipt["decision"]["authority"]
  grant?: ActionReviewReceipt["decision"]["grant"]
  expiresAt?: number
}) {
  seq += 1
  const id = `r-${seq}`
  await recordActionReviewReceipt({
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    id,
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: id,
      origin: {
        channel: "chat-tool",
        scope: "chat",
        id,
        rootSessionId: opts.root,
        instructionEpoch: opts.epoch,
      },
      subject: { kind: "tool-call", ref: "im_broadcast", targets: [toReviewTarget(GROUP)] },
      verdict: "ask",
      verdictExplicit: false,
      tier: "medium",
      surfaces: [],
      requestedAt: NOW - 10,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: id,
      outcome: opts.outcome,
      authority: opts.authority,
      decidedAt: NOW - 5,
      ...(opts.grant ? { grant: opts.grant } : {}),
    },
    expiresAt: opts.expiresAt ?? NOW + 1_000_000,
  })
}

function build(origin: ActionReviewPlanOrigin, extra: { unattended?: boolean } = {}) {
  return buildActionReviewPlanContext({
    origin,
    unattended: extra.unattended ?? false,
    via: "tool",
    now: NOW,
  })
}

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)
beforeEach(async () => {
  await dbFixture.restore()
  __clearRequestOriginCacheForTesting()
  __clearAllSubagentApprovalRoutesForTesting()
})

describe("readOutboundAuthorizationMode", () => {
  it("observes unless the setting is exactly enforce", () => {
    expect(readOutboundAuthorizationMode(undefined)).toBe("shadow")
    expect(readOutboundAuthorizationMode({})).toBe("shadow")
    expect(readOutboundAuthorizationMode({ agentPermissions: {} })).toBe("shadow")
    expect(
      readOutboundAuthorizationMode({ agentPermissions: { outboundAuthorization: "on" } })
    ).toBe("shadow")
    expect(
      readOutboundAuthorizationMode({ agentPermissions: { outboundAuthorization: "enforce" } })
    ).toBe("enforce")
  })

  it("leaves a context built without settings in shadow mode", async () => {
    expect((await build({})).mode).toBe("shadow")
  })
})

describe("buildActionReviewPlanContext", () => {
  it("fences a target a person denied, until the requester's epoch advances", async () => {
    await receipt({ root: "chat", epoch: "msg:u1", outcome: "deny", authority: "human" })
    const fenced = await build({ rootSessionId: "chat", instructionEpoch: "msg:u1" })
    expect([...fenced.fencedFingerprints]).toEqual([outboundFingerprint(GROUP)])
    expect(planActionReview({ verdict: "ask", targets: [GROUP] }, fenced).plan.outcome).toBe("deny")

    const next = await build({ rootSessionId: "chat", instructionEpoch: "msg:u2" })
    expect(next.fencedFingerprints.size).toBe(0)
    expect(planActionReview({ verdict: "ask", targets: [GROUP] }, next).plan.outcome).toBe("ask")
  })

  it("does not fence on a timeout, a system denial or another root's denial", async () => {
    await receipt({ root: "chat", epoch: "msg:u1", outcome: "deny", authority: "timeout" })
    await receipt({ root: "chat", epoch: "msg:u1", outcome: "expired", authority: "timeout" })
    await receipt({ root: "chat", epoch: "msg:u1", outcome: "deny", authority: "system" })
    await receipt({ root: "other", epoch: "msg:u1", outcome: "deny", authority: "human" })
    const context = await build({ rootSessionId: "chat", instructionEpoch: "msg:u1" })
    expect(context.fencedFingerprints.size).toBe(0)
  })

  it("ignores an expired receipt", async () => {
    await receipt({
      root: "chat",
      epoch: "msg:u1",
      outcome: "deny",
      authority: "human",
      expiresAt: NOW - 1,
    })
    expect(
      (await build({ rootSessionId: "chat", instructionEpoch: "msg:u1" })).fencedFingerprints
    ).toEqual(new Set())
  })

  it("reads instruction grants for the epoch, and not once grants", async () => {
    await receipt({
      root: "chat",
      epoch: "msg:u1",
      outcome: "allow",
      authority: "human",
      grant: { scope: "instruction" },
    })
    const context = await build({ rootSessionId: "chat", instructionEpoch: "msg:u1" })
    expect([...context.instructionGrants]).toEqual([outboundFingerprint(GROUP)])

    await dbFixture.restore()
    await receipt({
      root: "chat",
      epoch: "msg:u1",
      outcome: "allow",
      authority: "human",
      grant: { scope: "once" },
    })
    expect(
      (await build({ rootSessionId: "chat", instructionEpoch: "msg:u1" })).instructionGrants.size
    ).toBe(0)
  })

  it("has no fence and no grant for an origin without a root or an epoch", async () => {
    const listAuthKeys = jest.fn(async () => ["never"])
    const context = await buildActionReviewPlanContext({
      origin: { rootSessionId: "chat" },
      unattended: false,
      via: "tool",
      listAuthKeys,
    })
    expect(listAuthKeys).not.toHaveBeenCalled()
    expect(context.fencedFingerprints.size + context.instructionGrants.size).toBe(0)
  })

  it("keys the origin thread by fingerprint and keeps the first list per policy grant", async () => {
    const context = await buildActionReviewPlanContext({
      origin: { originThread: THREAD },
      unattended: true,
      via: "delivery",
      settings: { agentPermissions: { outboundAuthorization: "enforce" } },
      policyGrants: [
        { policyRef: "bot:b1", fingerprints: [outboundFingerprint(GROUP)] },
        { policyRef: "adapter:bot-a", fingerprints: [outboundFingerprint(GROUP)] },
      ],
    })
    expect(context).toMatchObject({ mode: "enforce", unattended: true, via: "delivery" })
    expect(context.originFingerprints).toEqual(new Set([outboundFingerprint(THREAD)]))
    expect(context.policyGrants).toEqual(new Map([[outboundFingerprint(GROUP), "bot:b1"]]))
  })

  it("reads the GitHub and browser modes on their own (ADR-0239 phase 2)", async () => {
    const build = (agentPermissions: object) =>
      buildActionReviewPlanContext({
        origin: {},
        unattended: false,
        via: "tool",
        settings: { agentPermissions },
      })
    expect((await build({ outboundAuthorization: "enforce" })).modes).toEqual({
      github: "shadow",
      browser: "shadow",
    })
    expect((await build({ outboundAuthorizationByCategory: { github: "enforce" } })).modes).toEqual(
      { github: "enforce", browser: "shadow" }
    )
  })

  it("keys a GitHub origin by its thread, so only that PR answers without asking", async () => {
    const pr = repositoryTarget("acme/web", 12)!
    const context = await buildActionReviewPlanContext({
      origin: { originThread: pr },
      unattended: true,
      via: "tool",
      settings: { agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } } },
    })
    expect(context.originFingerprints).toEqual(new Set([originMatchFingerprint(pr)]))
    expect(planActionReview({ verdict: "ask", targets: [pr] }, context).plan.outcome).toBe("allow")
    expect(
      planActionReview({ verdict: "ask", targets: [repositoryTarget("acme/web", 13)!] }, context)
        .plan.outcome
    ).toBe("park")
  })

  it("has no origin for a repository named without a thread", async () => {
    const context = await buildActionReviewPlanContext({
      origin: { originThread: repositoryTarget("acme/web")! },
      unattended: false,
      via: "tool",
    })
    expect(context.originFingerprints.size).toBe(0)
  })
})

describe("the fence across child runs and a reload", () => {
  it("blocks the same recipient from a subagent and from a teammate", async () => {
    await getDb().sessions.put({ id: "root", title: "r", createdAt: 1, updatedAt: 1 } as never)
    await getDb().messages.put({
      id: "u1",
      sessionId: "root",
      role: "user",
      parts: [{ type: "text", text: "draft it, don't send" }],
      createdAt: 10,
    } as never)
    const origin = await resolveSessionRequestOrigin("root")
    await receipt({
      root: origin.rootSessionId,
      epoch: origin.instructionEpoch,
      outcome: "deny",
      authority: "human",
    })

    registerSubagentApprovalRoute("eph", {
      parentSessionId: "root",
      runId: "run",
      subagentId: "writer",
      backgrounded: false,
    })
    // Each context is rebuilt from the stored receipts, as after a reload.
    for (const child of ["eph", subSessionId("root", "char-a", "turn-1")]) {
      const context = await build(await resolveSessionRequestOrigin(child))
      expect(planActionReview({ verdict: "ask", targets: [GROUP] }, context).plan.outcome).toBe(
        "deny"
      )
    }
  })
})

describe("task and Bot origins", () => {
  it("roots a task's runs at the task and its epoch at the person's revision", () => {
    expect(taskPlanOrigin({ id: "t1", humanRevision: 2 })).toEqual({
      rootSessionId: "task:t1",
      instructionEpoch: "task:t1@2",
    })
    expect(
      taskPlanOrigin({
        id: "t1",
        payload: {
          scheduleProvenance: {
            source: "im",
            adapterId: "bot-a",
            conversationKey: "lark:bot-a:oc_thread",
            senderId: "u-alice",
          },
        } as never,
      }).originThread
    ).toEqual(THREAD)
  })

  it("gives a Bot an epoch per person change and no origin thread", () => {
    expect(botPlanOrigin({ id: "b1", humanRevision: 4 })).toEqual({
      rootSessionId: "bot:b1",
      instructionEpoch: "bot:b1@4",
    })
  })
})
