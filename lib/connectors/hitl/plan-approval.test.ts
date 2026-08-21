import type { ConversationReference } from "@/types/connectors/event"

import { resolveApproval } from "./approval-registry"
import {
  applyPlanApprovalCallback,
  buildPlanApprovalSurface,
  makeImPlanApprovalDelegate,
  PLAN_APPROVE_PREFIX,
  PLAN_REJECT_PREFIX,
} from "./plan-approval"

const conversationRef: ConversationReference = {
  platform: "lark",
  adapterId: "lark-1",
  channelId: "chat-1",
}

function ctx(over: Partial<Parameters<typeof makeImPlanApprovalDelegate>[0]> = {}) {
  return {
    runId: "run_team_1",
    teamId: "team-1",
    objective: "Migrate billing",
    adapterId: "lark-1",
    conversationKey: "lark:lark-1:chat-1",
    conversationRef,
    initiatorUserId: "ou-user",
    enqueue: jest.fn(async () => undefined) as never,
    recordBinding: jest.fn(async () => undefined) as never,
    audit: jest.fn(async () => undefined) as never,
    ...over,
  }
}

describe("plan approval card", () => {
  it("tells the reader the plan was cut rather than silently truncating it", () => {
    // Someone who cannot see the tail must be told the tail exists, or they
    // approve something they did not read.
    const long = "step\n".repeat(1_000)
    const surface = buildPlanApprovalSurface({
      bindingId: "b1",
      objective: "Migrate billing",
      planText: long,
      revision: 0,
    })
    const planText = (surface.components.plan as { text: string }).text
    expect(planText.length).toBeLessThan(long.length)
    expect(planText).toContain("truncated")
  })

  it("names risk as the reason only when risk is what raised the gate", () => {
    const withRisk = buildPlanApprovalSurface({
      bindingId: "b1",
      objective: "o",
      planText: "p",
      riskReason: "shell access",
      revision: 0,
    })
    expect((withRisk.components.why as { text: string }).text).toContain("shell access")

    const withoutRisk = buildPlanApprovalSurface({
      bindingId: "b1",
      objective: "o",
      planText: "p",
      revision: 0,
    })
    expect((withoutRisk.components.why as { text: string }).text).toContain("lead proposed")
  })

  it("prints the buttons for a platform that cannot render them", () => {
    const surface = buildPlanApprovalSurface({
      bindingId: "b1",
      objective: "o",
      planText: "p",
      revision: 0,
    })
    expect(surface.widget?.fallbackText).toContain("Approve")
    expect(surface.widget?.fallbackText).toContain("回复 1 批准")
  })
})

describe("plan approval delegate", () => {
  it("scopes the buttons to the person who started the run", async () => {
    const recordBinding = jest.fn(async () => undefined)
    const delegate = makeImPlanApprovalDelegate(ctx({ recordBinding: recordBinding as never }))
    const pending = delegate({ planText: "the plan", revision: 0 })

    // Let the card go out before answering it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(recordBinding).toHaveBeenCalledTimes(2)
    for (const call of recordBinding.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0]).toMatchObject({
        kind: "plan_approve",
        actorScope: { mode: "initiator", allowedUserIds: ["ou-user"] },
      })
    }
    const actionIds = (recordBinding.mock.calls as unknown as Array<[{ actionId: string }]>).map(
      (call) => call[0].actionId
    )
    expect(actionIds.some((id) => id.startsWith(PLAN_APPROVE_PREFIX))).toBe(true)
    expect(actionIds.some((id) => id.startsWith(PLAN_REJECT_PREFIX))).toBe(true)

    resolveApproval("run_team_1", "plan-approval:run_team_1:0", { decision: "allow" })
    await expect(pending).resolves.toEqual({ outcome: "approve" })
  })

  it("carries the rejection feedback back as the revision instruction", async () => {
    // The lead's re-planning loop already consumes `feedback`; this is what
    // makes a person's chat reply the next revision's instruction.
    const delegate = makeImPlanApprovalDelegate(ctx())
    const pending = delegate({ planText: "the plan", revision: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    resolveApproval("run_team_1", "plan-approval:run_team_1:1", {
      decision: "deny",
      message: "do the migration in two passes",
    })

    await expect(pending).resolves.toEqual({
      outcome: "reject",
      feedback: "do the migration in two passes",
    })
  })

  it("keys each revision separately so a stale press cannot answer the new plan", async () => {
    const delegate = makeImPlanApprovalDelegate(ctx())
    const first = delegate({ planText: "v1", revision: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveApproval("run_team_1", "plan-approval:run_team_1:0", { decision: "deny" })
    await first

    const second = delegate({ planText: "v2", revision: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The OLD key no longer resolves anything.
    expect(resolveApproval("run_team_1", "plan-approval:run_team_1:0", { decision: "allow" })).toBe(
      false
    )
    resolveApproval("run_team_1", "plan-approval:run_team_1:1", { decision: "allow" })
    await expect(second).resolves.toEqual({ outcome: "approve" })
  })

  it("rejects rather than throwing when the card cannot be delivered", async () => {
    // `applyGateBehavior` treats a throwing delegate as fail-fast. A run that
    // dies because a card failed to send is worse than one that reports "not
    // approved": both refuse to proceed, only one says why where the loop can
    // act on it.
    const audit = jest.fn(async () => undefined)
    const delegate = makeImPlanApprovalDelegate(
      ctx({
        enqueue: (async () => {
          throw new Error("transport down")
        }) as never,
        audit: audit as never,
      })
    )

    await expect(delegate({ planText: "p", revision: 0 })).resolves.toEqual({
      outcome: "reject",
      feedback: "plan approval card could not be delivered",
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "plan_approval_card_failed" })
    )
  })

  it("resolves an expired card as a rejection so the lead re-plans", async () => {
    const delegate = makeImPlanApprovalDelegate(ctx({ ttlMs: 5 }))
    await expect(delegate({ planText: "p", revision: 0 })).resolves.toMatchObject({
      outcome: "reject",
    })
  })
})

describe("plan approval callback", () => {
  it("reports a press that answered a superseded revision as unresolved", () => {
    const result = applyPlanApprovalCallback({
      runId: "run_team_1",
      requestId: "plan-approval:run_team_1:0",
      decision: "approve",
      resolve: () => false,
    })
    expect(result).toEqual({ approved: true, resolved: false })
  })

  it("passes the typed feedback through to the waiter", () => {
    const resolve = jest.fn(() => true)
    applyPlanApprovalCallback({
      runId: "run_team_1",
      requestId: "r",
      decision: "reject",
      feedback: "split it up",
      resolve,
    })
    expect(resolve).toHaveBeenCalledWith("run_team_1", "r", {
      decision: "deny",
      message: "split it up",
    })
  })
})
