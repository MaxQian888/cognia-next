/**
 * Every collaborator is injected through `EscalationActionDeps`, so the
 * heavy modules (bus, notifications runtime, gateway) are mocked at the
 * module boundary and never touched.
 */

jest.mock("@/lib/notifications/runtime", () => ({ notify: jest.fn() }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  setAssignee: jest.fn(),
  updateConversationConfigSection: jest.fn(),
}))
jest.mock("@/lib/db/outbound-jobs", () => ({ waitForOutboundTerminal: jest.fn() }))
jest.mock("@/lib/connectors/delivery-gateway", () => ({ enqueueGoverned: jest.fn() }))
jest.mock("@/lib/connectors/session-bindings", () => ({ findSessionByConversationKey: jest.fn() }))
jest.mock("@/lib/connectors/bus", () => ({ getBus: jest.fn() }))
jest.mock("@/lib/connectors/assignment/notify-assignment", () => ({
  assignmentHref: (key: string) => `/inbox/c?key=${encodeURIComponent(key)}`,
  notifyAssignmentChanged: jest.fn(),
}))

import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  runEscalationAction,
  SLA_ESCALATION_NOTICE,
  URGENT_NOTICE_TIMEOUT_MS,
  type EscalationActionContext,
  type EscalationActionDeps,
} from "./actions"

const adapter = (over: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow =>
  ({ id: "adp-1", type: "lark", ...over }) as AdapterInstanceRow

const row = (over: Partial<ConversationOverrideRow> = {}): ConversationOverrideRow =>
  ({
    id: "co-1",
    conversationKey: "lark:adp-1:oc_1",
    sessionId: "s1",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as ConversationOverrideRow

function ctx(over: Partial<EscalationActionContext> = {}): EscalationActionContext {
  return {
    adapter: adapter(),
    row: row(),
    conversationKey: "lark:adp-1:oc_1",
    stepIndex: 1,
    overdueMinutes: 20,
    now: 1_000,
    ...over,
  }
}

function deps(over: Partial<EscalationActionDeps> = {}): EscalationActionDeps {
  return {
    notify: jest.fn(async () => "n1"),
    setAssignee: jest.fn(async () => undefined),
    notifyAssignmentChanged: jest.fn(async () => undefined),
    updateConversationConfigSection: jest.fn(async () => row()),
    enqueueGoverned: jest.fn(async () => ({ id: "job-1" }) as never),
    waitForOutboundTerminal: jest.fn(async () => ({
      id: "job-1",
      status: "sent",
      platformMessageId: "om_1",
    })) as never,
    findSessionByConversationKey: jest.fn(async () => ({
      id: "s1",
      platformBinding: {
        adapterId: "adp-1",
        conversationKey: "lark:adp-1:oc_1",
        platform: "lark",
        conversationRef: { platform: "lark", adapterId: "adp-1", chatId: "oc_1" },
        deliveryTarget: { kind: "chat" },
      },
    })) as never,
    getBus: () => ({
      getAdapter: () => ({ sendUrgent: jest.fn() }) as never,
      sendUrgentOutbound: jest.fn(async () => ({ ok: true })),
    }),
    ...over,
  }
}

describe("runEscalationAction — notify", () => {
  it("posts a warning to center + toast with the sla dedupe key", async () => {
    const d = deps()
    const outcome = await runEscalationAction(ctx(), { type: "notify" }, d)
    expect(outcome).toEqual({ ok: true })
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "connector",
        level: "warning",
        title: SLA_ESCALATION_NOTICE.overdue.title,
        body: SLA_ESCALATION_NOTICE.overdue.body(20, 1),
        channels: ["center", "toast"],
        href: "/inbox/c?key=lark%3Aadp-1%3Aoc_1",
        dedupeKey: "sla:lark:adp-1:oc_1:1",
        groupKey: "lark:adp-1:oc_1",
        directed: true,
      })
    )
    expect(SLA_ESCALATION_NOTICE.overdue.body(20, 1)).toContain("L2")
  })

  it("reports notify_failed instead of throwing", async () => {
    const d = deps({ notify: jest.fn(async () => Promise.reject(new Error("down"))) })
    expect(await runEscalationAction(ctx(), { type: "notify" }, d)).toEqual({
      ok: false,
      reason: "notify_failed",
      message: "down",
    })
  })
})

describe("runEscalationAction — reassign", () => {
  it("assigns via setAssignee({ via: sla-escalation }) and notifies the change", async () => {
    const d = deps()
    const current = row({ assignee: { kind: "character", id: "c1" } })
    const outcome = await runEscalationAction(
      ctx({ row: current }),
      { type: "reassign", assignee: { kind: "team", id: "t1", label: "Ops" } },
      d
    )
    expect(outcome).toEqual({ ok: true })
    expect(d.setAssignee).toHaveBeenCalledWith(
      "lark:adp-1:oc_1",
      { kind: "team", id: "t1", label: "Ops" },
      { sessionId: "s1", via: "sla-escalation", adapterId: "adp-1" }
    )
    expect(d.notifyAssignmentChanged).toHaveBeenCalledWith({
      conversationKey: "lark:adp-1:oc_1",
      from: { kind: "character", id: "c1" },
      to: { kind: "team", id: "t1", label: "Ops" },
      via: "sla-escalation",
    })
  })

  it("reports reassign_failed and skips the notification when the write throws", async () => {
    const d = deps({ setAssignee: jest.fn(async () => Promise.reject(new Error("no row"))) })
    expect(
      await runEscalationAction(ctx(), { type: "reassign", assignee: { kind: "human" } }, d)
    ).toEqual({ ok: false, reason: "reassign_failed", message: "no row" })
    expect(d.notifyAssignmentChanged).not.toHaveBeenCalled()
  })
})

describe("runEscalationAction — switchMode", () => {
  it("writes the behavior section with source sla-escalation", async () => {
    const d = deps()
    expect(await runEscalationAction(ctx(), { type: "switchMode", mode: "draft" }, d)).toEqual({
      ok: true,
    })
    expect(d.updateConversationConfigSection).toHaveBeenCalledWith({
      adapterId: "adp-1",
      conversationKey: "lark:adp-1:oc_1",
      sessionId: "s1",
      section: "behavior",
      patch: { mode: "draft" },
      source: "sla-escalation",
    })
  })

  it("reports switch_mode_failed", async () => {
    const d = deps({
      updateConversationConfigSection: jest.fn(async () => Promise.reject("boom")) as never,
    })
    expect(await runEscalationAction(ctx(), { type: "switchMode", mode: "manual" }, d)).toEqual({
      ok: false,
      reason: "switch_mode_failed",
      message: "boom",
    })
  })
})

describe("runEscalationAction — urgent (Lark only; inert elsewhere)", () => {
  const urgent = { type: "urgent" as const, userIds: ["ou_a", " ou_b "], via: "sms" as const }

  it("is recorded as unsupported_platform on non-Lark adapters without touching the bus", async () => {
    const d = deps({ getBus: jest.fn() as never })
    for (const type of ["telegram", "discord", "slack", "wecom"] as const) {
      expect(await runEscalationAction(ctx({ adapter: adapter({ type }) }), urgent, d)).toEqual({
        ok: false,
        reason: "unsupported_platform",
      })
    }
    expect(d.getBus).not.toHaveBeenCalled()
  })

  it("enqueues a governed notice, awaits its terminal status, then escalates the platform message id", async () => {
    const sendUrgentOutbound = jest.fn(async () => ({ ok: true }))
    const d = deps({
      getBus: () => ({
        getAdapter: () => ({ sendUrgent: jest.fn() }) as never,
        sendUrgentOutbound,
      }),
    })
    expect(await runEscalationAction(ctx(), urgent, d)).toEqual({ ok: true })
    expect(d.enqueueGoverned).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "adp-1",
        conversationKey: "lark:adp-1:oc_1",
        source: "manual",
        request: expect.objectContaining({
          conversationRef: { platform: "lark", adapterId: "adp-1", chatId: "oc_1" },
          deliveryTarget: { kind: "chat" },
          segments: [{ type: "text", text: SLA_ESCALATION_NOTICE.urgent.text(20) }],
          metadata: { idempotencyKey: "sla-urgent:lark:adp-1:oc_1:1" },
        }),
      })
    )
    expect(d.waitForOutboundTerminal).toHaveBeenCalledWith("job-1", URGENT_NOTICE_TIMEOUT_MS)
    expect(sendUrgentOutbound).toHaveBeenCalledWith("adp-1", "om_1", ["ou_a", "ou_b"], "sms")
  })

  it("targets another conversation when targetConversationKey is set and mentions the source key", async () => {
    const findSession = jest.fn(async (key: string) => ({
      id: "s-ops",
      platformBinding: {
        adapterId: "adp-1",
        conversationKey: key,
        platform: "lark",
        conversationRef: { platform: "lark", adapterId: "adp-1", chatId: "oc_ops" },
      },
    }))
    const d = deps({ findSessionByConversationKey: findSession as never })
    await runEscalationAction(ctx(), { ...urgent, targetConversationKey: "lark:adp-1:oc_ops" }, d)
    expect(findSession).toHaveBeenCalledWith("lark:adp-1:oc_ops")
    expect(d.enqueueGoverned).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "lark:adp-1:oc_ops",
        request: expect.objectContaining({
          segments: [
            {
              type: "text",
              text: SLA_ESCALATION_NOTICE.urgent.text(20, "lark:adp-1:oc_1"),
            },
          ],
        }),
      })
    )
  })

  it("maps every precondition failure to a reason code", async () => {
    expect(await runEscalationAction(ctx(), { type: "urgent", userIds: [" "] }, deps())).toEqual({
      ok: false,
      reason: "urgent_users_missing",
    })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({ getBus: () => ({ getAdapter: () => undefined, sendUrgentOutbound: jest.fn() }) })
      )
    ).toEqual({ ok: false, reason: "adapter_offline" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({
          getBus: () => ({ getAdapter: () => ({}) as never, sendUrgentOutbound: jest.fn() }),
        })
      )
    ).toEqual({ ok: false, reason: "unsupported_platform" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({ findSessionByConversationKey: jest.fn(async () => undefined) as never })
      )
    ).toEqual({ ok: false, reason: "no_bound_session" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({
          findSessionByConversationKey: jest.fn(async () => ({
            platformBinding: { adapterId: "other", conversationRef: {} },
          })) as never,
        })
      )
    ).toEqual({ ok: false, reason: "target_adapter_mismatch" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({ enqueueGoverned: jest.fn(async () => Promise.reject(new Error("pii"))) as never })
      )
    ).toEqual({ ok: false, reason: "notice_enqueue_failed", message: "pii" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({ waitForOutboundTerminal: jest.fn(async () => undefined) as never })
      )
    ).toEqual({ ok: false, reason: "notice_not_delivered", message: "timeout" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({
          waitForOutboundTerminal: jest.fn(async () => ({
            status: "deadlettered",
            lastError: "platform_4xx",
          })) as never,
        })
      )
    ).toEqual({ ok: false, reason: "notice_not_delivered", message: "platform_4xx" })
    expect(
      await runEscalationAction(
        ctx(),
        urgent,
        deps({
          getBus: () => ({
            getAdapter: () => ({ sendUrgent: jest.fn() }) as never,
            sendUrgentOutbound: jest.fn(async () => ({
              ok: false,
              error: { code: "platform_error", message: "scope missing", retryable: false },
            })),
          }),
        })
      )
    ).toEqual({ ok: false, reason: "platform_error", message: "scope missing" })
  })
})

describe("runEscalationAction — default collaborators", () => {
  it("wires the module-level notify / setAssignee / config-section / bus seams when no deps are injected", async () => {
    const { notify } = jest.requireMock<typeof import("@/lib/notifications/runtime")>(
      "@/lib/notifications/runtime"
    )
    const { setAssignee, updateConversationConfigSection } = jest.requireMock<
      typeof import("@/lib/db/conversation-overrides")
    >("@/lib/db/conversation-overrides")
    const { notifyAssignmentChanged } = jest.requireMock<
      typeof import("@/lib/connectors/assignment/notify-assignment")
    >("@/lib/connectors/assignment/notify-assignment")
    const { getBus } =
      jest.requireMock<typeof import("@/lib/connectors/bus")>("@/lib/connectors/bus")
    const { findSessionByConversationKey } = jest.requireMock<
      typeof import("@/lib/connectors/session-bindings")
    >("@/lib/connectors/session-bindings")
    const { enqueueGoverned } = jest.requireMock<
      typeof import("@/lib/connectors/delivery-gateway")
    >("@/lib/connectors/delivery-gateway")
    const { waitForOutboundTerminal } =
      jest.requireMock<typeof import("@/lib/db/outbound-jobs")>("@/lib/db/outbound-jobs")
    ;(notify as jest.Mock).mockResolvedValue("n")
    ;(setAssignee as jest.Mock).mockResolvedValue(undefined)
    ;(notifyAssignmentChanged as jest.Mock).mockResolvedValue(undefined)
    ;(updateConversationConfigSection as jest.Mock).mockResolvedValue(row())
    ;(getBus as jest.Mock).mockReturnValue({
      getAdapter: () => ({ sendUrgent: jest.fn() }),
      sendUrgentOutbound: jest.fn(async () => ({ ok: false })),
    })
    ;(findSessionByConversationKey as jest.Mock).mockResolvedValue({
      platformBinding: { adapterId: "adp-1", conversationRef: {} },
    })
    ;(enqueueGoverned as jest.Mock).mockResolvedValue({ id: "j" })
    ;(waitForOutboundTerminal as jest.Mock).mockResolvedValue({
      status: "sent",
      platformMessageId: "om",
    })

    expect(await runEscalationAction(ctx(), { type: "notify" })).toEqual({ ok: true })
    expect(notify).toHaveBeenCalled()
    expect(
      await runEscalationAction(ctx({ row: row({ assignee: undefined }) }), {
        type: "reassign",
        assignee: { kind: "human" },
      })
    ).toEqual({ ok: true })
    expect(setAssignee).toHaveBeenCalled()
    expect(notifyAssignmentChanged).toHaveBeenCalledWith(expect.objectContaining({ from: null }))
    expect(await runEscalationAction(ctx(), { type: "switchMode", mode: "manual" })).toEqual({
      ok: true,
    })
    expect(updateConversationConfigSection).toHaveBeenCalled()
    // urgent through the real seams; a bus failure without an error object
    // maps to the generic reason.
    expect(
      await runEscalationAction(ctx(), { type: "urgent", userIds: undefined as never })
    ).toEqual({ ok: false, reason: "urgent_users_missing" })
    expect(await runEscalationAction(ctx(), { type: "urgent", userIds: ["u"] })).toEqual({
      ok: false,
      reason: "urgent_failed",
    })
    ;(findSessionByConversationKey as jest.Mock).mockRejectedValueOnce(new Error("db"))
    expect(await runEscalationAction(ctx(), { type: "urgent", userIds: ["u"] })).toEqual({
      ok: false,
      reason: "no_bound_session",
    })
  })
})

describe("runEscalationAction — guards", () => {
  it("never throws: unknown action type and thrown collaborators become outcomes", async () => {
    expect(await runEscalationAction(ctx(), { type: "bogus" } as never, deps())).toEqual({
      ok: false,
      reason: "action_type_unknown",
      message: "bogus",
    })
    expect(
      await runEscalationAction(
        ctx(),
        { type: "urgent", userIds: ["u"] },
        deps({
          getBus: () => {
            throw new Error("bus not installed")
          },
        })
      )
    ).toEqual({ ok: false, reason: "action_threw", message: "bus not installed" })
  })
})
