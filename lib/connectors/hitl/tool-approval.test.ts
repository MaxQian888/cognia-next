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
} from "./tool-approval"
import {
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
  bindings: Array<{ actionId: string; kind?: string; payload?: Record<string, unknown> }>
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
    }) => {
      bindings.push({ actionId: b.actionId, kind: b.kind, payload: b.payload })
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
