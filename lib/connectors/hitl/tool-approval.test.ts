import { settleApprovalCard } from "./approval-card-state"
jest.mock("./approval-card-state", () => ({ settleApprovalCard: jest.fn(async () => undefined) }))
// A run-owned card writes its interrupt row; the row's lifecycle is tested in
// `lib/execution/run-control.test.ts`.
jest.mock("@/lib/execution/run-control", () => ({
  createRunInterrupt: jest.fn(async () => undefined),
  resolveRunInterruptFromSource: jest.fn(async () => undefined),
  expireRunInterruptFromSource: jest.fn(async () => undefined),
}))
/**
 * Tests for lib/connectors/hitl/tool-approval.ts — the IM permission responder,
 * card builder, and callback applier.
 */

import {
  makeImPermissionResponder,
  buildToolApprovalSurface,
  applyToolApprovalCallback,
  TOOL_APPROVE_PREFIX,
  TOOL_DENY_PREFIX,
  TOOL_ALLOW_SESSION_PREFIX,
  TOOL_ALLOW_REQUEST_PREFIX,
  CONNECTOR_TURN_TIMEOUT_MS,
  imRecipientLine,
} from "./tool-approval"
import {
  DEFAULT_APPROVAL_TTL_MS,
  resolveApproval,
  hasSessionBypass,
  grantSessionBypass,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
} from "./approval-registry"
import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"

const REF: ConversationReference = { platform: "telegram", adapterId: "tg-1" }

function req(over: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    requestId: "req_1",
    toolName: "Bash",
    input: {},
    ...over,
  } as PermissionRequestEvent
}

interface Harness {
  enqueued: Array<{ segments: unknown[]; deliveryTarget?: ConversationDeliveryTarget }>
  bindings: Array<{
    actionId: string
    kind?: string
    payload?: Record<string, unknown>
    actorScope?: { mode: string; allowedUserIds?: string[] }
    allowedActions?: string[]
  }>
  audits: string[]
  ctx: Parameters<typeof makeImPermissionResponder>[0]
}

function harness(
  approvalMode?: "prompt" | "yolo",
  deliveryTarget?: ConversationDeliveryTarget
): Harness {
  const enqueued: Harness["enqueued"] = []
  const bindings: Harness["bindings"] = []
  const audits: string[] = []
  const ctx = {
    sessionId: "s1",
    adapterId: "tg-1",
    conversationKey: "telegram:tg-1:9",
    conversationRef: REF,
    deliveryTarget,
    approvalMode,
    enqueue: (async (job: {
      request: { segments: unknown[]; deliveryTarget?: ConversationDeliveryTarget }
    }) => {
      enqueued.push({
        segments: job.request.segments,
        deliveryTarget: job.request.deliveryTarget,
      })
    }) as unknown as Harness["ctx"]["enqueue"],
    recordBinding: (async (b: {
      actionId: string
      kind?: string
      payload?: Record<string, unknown>
      actorScope?: { mode: string; allowedUserIds?: string[] }
      allowedActions?: string[]
    }) => {
      bindings.push({
        actionId: b.actionId,
        kind: b.kind,
        payload: b.payload,
        actorScope: b.actorScope,
        allowedActions: b.allowedActions,
      })
    }) as Harness["ctx"]["recordBinding"],
    audit: (async (e: { kind: string }) => {
      audits.push(e.kind)
    }) as unknown as Harness["ctx"]["audit"],
    ttlMs: 0,
  }
  return { enqueued, bindings, audits, ctx }
}

beforeEach(() => __resetApprovalRegistryForTesting())

describe("buildToolApprovalSurface", () => {
  it("emits a Card with three decision buttons + a numeric fallback", () => {
    const s = buildToolApprovalSurface({ bindingId: "abcd1234", toolName: "Bash" })
    expect(s.rootId).toBe("root")
    const comps = s.components as Record<string, { value?: string }>
    expect(comps.allow.value).toBe(TOOL_APPROVE_PREFIX + "abcd1234")
    expect(comps.deny.value).toBe(TOOL_DENY_PREFIX + "abcd1234")
    expect(comps.allowSession.value).toBe(TOOL_ALLOW_SESSION_PREFIX + "abcd1234")
    expect((s.widget as { fallbackText: string }).fallbackText).toMatch(/回复 1/)
  })
})

describe("buildToolApprovalSurface — per-call asks (ADR-0201, ADR-0239)", () => {
  it("offers no allow-for-session button, in the card or its numeric fallback", () => {
    const s = buildToolApprovalSurface({
      bindingId: "abcd1234",
      toolName: "im_broadcast",
      perCall: true,
    })
    const comps = s.components as Record<string, { children?: string[] }>
    expect(comps.allowSession).toBeUndefined()
    expect(comps.actions.children).toEqual(["allow", "deny"])
    const fallback = (s.widget as { fallbackText: string }).fallbackText
    expect(fallback).toMatch(/回复 1 允许 \/ 2 拒绝$/)
    expect(fallback).not.toMatch(/Allow for session/)
  })
})

describe("buildToolApprovalSurface — outbound asks (ADR-0239)", () => {
  const chat = {
    kind: "conversation",
    channel: "bot-a",
    recipient: "conv:lark:bot-a:oc_1",
  } as const

  it("names the recipients, says a deny fences them, and offers the request third", () => {
    const s = buildToolApprovalSurface({
      bindingId: "abcd1234",
      toolName: "im_broadcast",
      perCall: true,
      recipients: [chat],
      allowForRequest: true,
    })
    const comps = s.components as Record<
      string,
      { children?: string[]; text?: string; value?: string }
    >
    expect(comps.root.children).toEqual(["prompt", "recipients", "actions"])
    expect(comps.recipients.text).toContain(imRecipientLine(chat))
    expect(comps.recipients.text).toContain("Deny also stops sending")
    expect(comps.actions.children).toEqual(["allow", "deny", "allowRequest"])
    expect(comps.allowRequest.value).toBe(TOOL_ALLOW_REQUEST_PREFIX + "abcd1234")
    const fallback = (s.widget as { fallbackText: string }).fallbackText
    expect(fallback).toContain(imRecipientLine(chat))
    expect(fallback).toMatch(/回复 1 允许 \/ 2 拒绝 \/ 3 本次请求内允许$/)
  })

  it("offers only this call when a recipient cannot be named", () => {
    const s = buildToolApprovalSurface({
      bindingId: "abcd1234",
      toolName: "deploy_site",
      perCall: true,
      recipients: [
        { kind: "public", channel: "tool:deploy_site", recipient: "public:deploy_site" },
      ],
      allowForRequest: false,
    })
    const comps = s.components as Record<string, { children?: string[] }>
    expect(comps.actions.children).toEqual(["allow", "deny"])
    expect((s.widget as { fallbackText: string }).fallbackText).toContain(
      "公开链接 / Public link（deploy_site）"
    )
  })

  it("writes every kind of recipient", () => {
    expect(imRecipientLine(chat)).toBe("会话 / Chat oc_1（bot-a）")
    expect(
      imRecipientLine({ kind: "person", channel: "bot-a", recipient: "person:bot-a:ou_7" })
    ).toBe("成员 / Person ou_7（bot-a）")
    expect(imRecipientLine({ kind: "mail", channel: "mail", recipient: "mail:a@b.co" })).toBe(
      "邮箱 / Email a@b.co"
    )
    expect(imRecipientLine({ kind: "unknown", channel: "tool:x", recipient: "*" })).toMatch(
      /could not name/
    )
  })
})

describe("makeImPermissionResponder — outbound asks (ADR-0239)", () => {
  const targets = [
    { kind: "conversation" as const, channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" },
  ]

  it("binds allow-for-request and hands the person's choice back", async () => {
    const h = harness()
    const pending = makeImPermissionResponder(h.ctx)(
      req({
        toolName: "im_broadcast",
        requiresPerCallApproval: true,
        outbound: { enforced: true, targets, unauthorized: targets },
      })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(h.bindings.map((b) => b.payload?.decision)).toEqual(["allow", "deny", "allow_request"])
    expect(h.bindings[2]).toMatchObject({
      actionId: expect.stringMatching(/^tapr:/),
      allowedActions: ["approve"],
    })
    applyToolApprovalCallback({
      sessionId: "s1",
      requestId: "req_1",
      toolName: "im_broadcast",
      decision: "allow_request",
      resolve: resolveApproval,
    })
    await expect(pending).resolves.toEqual({ decision: "allow", forRequest: true })
  })

  it("lists the recipients for a paired phone while the run's card waits", async () => {
    const { runApprovalOutbound } = await import("@/lib/execution/run-approval-outbound")
    const h = harness()
    h.ctx.runId = "run-im"
    const review = { enforced: true, targets, unauthorized: targets }
    const pending = makeImPermissionResponder(h.ctx)(
      req({ toolName: "im_broadcast", requiresPerCallApproval: true, outbound: review })
    )
    for (let i = 0; i < 50 && !runApprovalOutbound("tool-interrupt:run-im:req_1"); i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(runApprovalOutbound("tool-interrupt:run-im:req_1")).toBe(review)
    resolveApproval("s1", "req_1", { decision: "deny" })
    await pending
    expect(runApprovalOutbound("tool-interrupt:run-im:req_1")).toBeUndefined()
  })

  it("shows no recipients in shadow mode", async () => {
    const h = harness()
    const pending = makeImPermissionResponder(h.ctx)(
      req({ toolName: "im_broadcast", outbound: { enforced: false, targets, unauthorized: [] } })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.stringify(h.enqueued[0].segments)).not.toContain("Sends to")
    expect(h.bindings.map((b) => b.payload?.decision)).toEqual(["allow", "deny", "allow_session"])
    resolveApproval("s1", "req_1", { decision: "deny" })
    await pending
  })
})

describe("makeImPermissionResponder — per-call asks", () => {
  it("asks even in yolo mode or with a session bypass, and records no session binding", async () => {
    grantSessionBypass("s1", "Bash")
    const h = harness("yolo")
    const pending = makeImPermissionResponder(h.ctx)(req({ requiresPerCallApproval: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.enqueued).toHaveLength(1)
    expect(h.bindings.map((b) => b.actionId)).not.toContainEqual(
      expect.stringContaining(TOOL_ALLOW_SESSION_PREFIX)
    )
    expect(h.bindings).toHaveLength(2)
    resolveApproval("s1", "req_1", { decision: "allow" })
    await expect(pending).resolves.toEqual({ decision: "allow" })
  })
})

describe("makeImPermissionResponder", () => {
  it("auto-allows in yolo mode without surfacing a card", async () => {
    const h = harness("yolo")
    const responder = makeImPermissionResponder(h.ctx)
    await expect(responder(req())).resolves.toEqual({ decision: "allow" })
    expect(h.enqueued).toHaveLength(0)
    expect(h.bindings).toHaveLength(0)
  })

  it("auto-allows when the tool already has a session bypass", async () => {
    grantSessionBypass("s1", "Bash")
    const h = harness("prompt")
    const responder = makeImPermissionResponder(h.ctx)
    await expect(responder(req())).resolves.toEqual({ decision: "allow" })
    expect(h.enqueued).toHaveLength(0)
  })

  it("surfaces a card, records 3 bindings, audits, and suspends", async () => {
    const h = harness("prompt")
    const responder = makeImPermissionResponder(h.ctx)
    const pending = responder(req())
    // Flush the responder's internal awaits (bindings → enqueue → audit →
    // register) without awaiting the suspended approval promise itself.
    await new Promise((r) => setTimeout(r, 0))
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0].segments).toHaveLength(1)
    expect(h.bindings).toHaveLength(3)
    expect(h.bindings.every((b) => b.kind === "tool_approve")).toBe(true)
    expect(h.bindings[0].payload).toMatchObject({
      sessionId: "s1",
      requestId: "req_1",
      toolName: "Bash",
      decision: "allow",
    })
    expect(h.audits).toContain("tool_approve.requested")
    expect(pendingApprovalCount()).toBe(1)

    // Resolve via the registry → the suspended promise settles.
    resolveApproval("s1", "req_1", { decision: "allow" })
    await expect(pending).resolves.toEqual({ decision: "allow" })
    expect(settleApprovalCard).toHaveBeenCalledWith(expect.objectContaining({ state: "approved" }))
  })

  it("carries the persisted delivery target onto the approval job", async () => {
    const target: ConversationDeliveryTarget = {
      address: {
        conversationKey: "lark:lk-1:oc-1:omt-1",
        platform: "lark",
        adapterId: "lk-1",
        scopeKind: "thread",
        containerId: "oc-1",
        topicId: "omt-1",
      },
      conversationRef: {
        platform: "lark",
        adapterId: "lk-1",
        channelId: "oc-1",
        threadTs: "omt-1",
        threadRootMessageId: "om-1",
      },
      sourceMessageId: "om-1",
      refreshedAt: 1,
    }
    const h = harness("prompt", target)
    const pending = makeImPermissionResponder(h.ctx)(req())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.enqueued[0].deliveryTarget).toEqual(target)
    resolveApproval("s1", "req_1", { decision: "deny" })
    await pending
  })

  it("denies (fail-closed) when surfacing the card throws", async () => {
    const h = harness("prompt")
    h.ctx.recordBinding = (async () => {
      throw new Error("dexie down")
    }) as Harness["ctx"]["recordBinding"]
    const responder = makeImPermissionResponder(h.ctx)
    await expect(responder(req())).resolves.toEqual({
      decision: "deny",
      message: "failed to surface approval card",
    })
  })

  it("gives connector turns more time than an approval may wait", () => {
    expect(CONNECTOR_TURN_TIMEOUT_MS).toBeGreaterThan(DEFAULT_APPROVAL_TTL_MS)
  })
})

describe("makeImPermissionResponder — onUnanswered", () => {
  const unattendedDecision = { decision: "deny" as const, message: "nobody answered" }

  it("hands a card that expired untapped to onUnanswered", async () => {
    const h = harness("prompt")
    const onUnanswered = jest.fn(() => unattendedDecision)
    const responder = makeImPermissionResponder({ ...h.ctx, ttlMs: 5, onUnanswered })

    await expect(responder(req())).resolves.toEqual(unattendedDecision)
    expect(onUnanswered).toHaveBeenCalledWith(req())
    expect(settleApprovalCard).toHaveBeenCalledWith(expect.objectContaining({ state: "expired" }))
  })

  it("hands a card it could not surface to onUnanswered", async () => {
    const h = harness("prompt")
    const onUnanswered = jest.fn(async () => unattendedDecision)
    h.ctx.enqueue = (async () => {
      throw new Error("outbox down")
    }) as unknown as Harness["ctx"]["enqueue"]

    await expect(makeImPermissionResponder({ ...h.ctx, onUnanswered })(req())).resolves.toEqual(
      unattendedDecision
    )
    expect(onUnanswered).toHaveBeenCalledTimes(1)
  })

  it("returns a human's Deny as it is, without onUnanswered", async () => {
    const h = harness("prompt")
    const onUnanswered = jest.fn(() => unattendedDecision)
    const pending = makeImPermissionResponder({ ...h.ctx, onUnanswered })(req())
    await new Promise((r) => setTimeout(r, 0))

    resolveApproval("s1", "req_1", { decision: "deny" })
    await expect(pending).resolves.toEqual({ decision: "deny" })
    expect(onUnanswered).not.toHaveBeenCalled()
  })

  it("does not treat the owner ending the wait as unanswered", async () => {
    const h = harness("prompt")
    const onUnanswered = jest.fn(() => unattendedDecision)
    const owner = new AbortController()
    const pending = makeImPermissionResponder({ ...h.ctx, signal: owner.signal, onUnanswered })(
      req()
    )
    await new Promise((r) => setTimeout(r, 0))

    owner.abort()
    await expect(pending).resolves.toEqual({ decision: "deny", message: "approval owner ended" })
    expect(onUnanswered).not.toHaveBeenCalled()
  })

  it("never consults onUnanswered for an auto-allowed tool", async () => {
    const onUnanswered = jest.fn(() => unattendedDecision)
    await expect(
      makeImPermissionResponder({ ...harness("yolo").ctx, onUnanswered })(req())
    ).resolves.toEqual({ decision: "allow" })
    expect(onUnanswered).not.toHaveBeenCalled()
  })
})

describe("applyToolApprovalCallback", () => {
  it("grants on allow and resolves the registry", () => {
    const calls: Array<{ decision: unknown }> = []
    const out = applyToolApprovalCallback({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      decision: "allow",
      resolve: (_s, _r, d) => {
        calls.push({ decision: d })
        return true
      },
    })
    expect(out).toEqual({ granted: true, resolved: true })
    expect(calls[0].decision).toEqual({ decision: "allow" })
  })

  it("denies and resolves with deny", () => {
    const out = applyToolApprovalCallback({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      decision: "deny",
      resolve: () => true,
    })
    expect(out.granted).toBe(false)
  })

  it("allow_request resolves an allow for the request, with no session bypass", () => {
    const calls: unknown[] = []
    const out = applyToolApprovalCallback({
      sessionId: "s8",
      requestId: "r1",
      toolName: "im_broadcast",
      decision: "allow_request",
      resolve: (_s, _r, d) => {
        calls.push(d)
        return true
      },
    })
    expect(out).toEqual({ granted: true, resolved: true })
    expect(calls).toEqual([{ decision: "allow", forRequest: true }])
    expect(hasSessionBypass("s8", "im_broadcast")).toBe(false)
  })

  it("allow_session grants the per-session bypass", () => {
    applyToolApprovalCallback({
      sessionId: "s9",
      requestId: "r1",
      toolName: "Edit",
      decision: "allow_session",
      resolve: () => true,
    })
    expect(hasSessionBypass("s9", "Edit")).toBe(true)
  })
})

describe("approval binding actor scope (plan 2026-07-24 Phase 2)", () => {
  it("stamps initiator scope + wire-verb allowedActions when initiatorUserId is known", async () => {
    const h = harness("prompt")
    h.ctx.initiatorUserId = "u_init"
    const responder = makeImPermissionResponder(h.ctx)
    void responder(req())
    await new Promise((r) => setTimeout(r, 0))

    expect(h.bindings).toHaveLength(3)
    for (const b of h.bindings) {
      expect(b.actorScope).toEqual({ mode: "initiator", allowedUserIds: ["u_init"] })
    }
    const byComponent = Object.fromEntries(
      h.bindings.map((b) => [b.payload?.decision, b.allowedActions])
    )
    // Allow / allow-session buttons emit wire action "approve"; deny emits "cancel".
    expect(byComponent.allow).toEqual(["approve"])
    expect(byComponent.allow_session).toEqual(["approve"])
    expect(byComponent.deny).toEqual(["cancel"])
  })

  it("falls back to operators-only scope without an initiator", async () => {
    const h = harness("prompt")
    const responder = makeImPermissionResponder(h.ctx)
    void responder(req())
    await new Promise((r) => setTimeout(r, 0))
    for (const b of h.bindings) {
      expect(b.actorScope).toEqual({ mode: "operators" })
    }
  })
})

it("does not grant session bypass from an already resolved card", () => {
  __resetApprovalRegistryForTesting()
  expect(
    applyToolApprovalCallback({
      sessionId: "stale",
      requestId: "old",
      toolName: "Bash",
      decision: "allow_session",
      resolve: () => false,
    })
  ).toEqual({ granted: false, resolved: false })
  expect(hasSessionBypass("stale", "Bash")).toBe(false)
})

it("keeps existing prefix exports compatible with the shared registry", async () => {
  const registry = await import("@/lib/connectors/hitl/callback-prefixes")
  expect([TOOL_APPROVE_PREFIX, TOOL_DENY_PREFIX, TOOL_ALLOW_SESSION_PREFIX]).toEqual([
    registry.TOOL_APPROVE_PREFIX,
    registry.TOOL_DENY_PREFIX,
    registry.TOOL_ALLOW_SESSION_PREFIX,
  ])
})
