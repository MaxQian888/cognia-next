/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { handleUnresolvedPrincipal, type UnresolvedPrincipalDependencies } from "./unbound"
import { hashOpenId } from "./resolve"

const T0 = 1_753_000_000_000

function event(): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lk-1",
    selfId: "bot",
    messageId: "om-1",
    conversationRef: { platform: "lark", adapterId: "lk-1", channelId: "oc-1" },
    conversationKey: "lark:lk-1:oc-1",
    sender: { id: "lark:ou_1", platform: "lark", adapterId: "lk-1", remoteUserId: "ou_1" },
    channel: { id: "lark:lk-1:oc-1", kind: "group" },
    segments: [{ type: "text", text: "hi" }],
    plainText: "hi",
    mentions: { selfMentioned: false, users: [] },
    timestamp: T0,
    raw: {},
  }
}

function makeDeps() {
  return {
    enqueue: jest.fn(async (_input: unknown) => ({}) as never),
    audit: jest.fn(async (_input: unknown) => ({}) as never),
    bindRequest: jest.fn(async (_input: unknown) => ({ id: "fb_code1" }) as never),
    markHistoryOnly: jest.fn(async (_id: unknown, _reason: unknown, _opts?: unknown) => undefined),
    now: () => T0,
  } as unknown as UnresolvedPrincipalDependencies & {
    enqueue: jest.Mock
    audit: jest.Mock
    bindRequest: jest.Mock
    markHistoryOnly: jest.Mock
  }
}

describe("handleUnresolvedPrincipal", () => {
  it("parks the job, audits with a hashed open_id, and replies once per day for unbound", async () => {
    const deps = makeDeps()
    const expectedHash = await hashOpenId("ou_1")
    await handleUnresolvedPrincipal(
      event(),
      { id: "lk-1" },
      { status: "unbound", tenantKey: "tk_a", appId: "cli_1", openIdHash: expectedHash },
      "job-1",
      deps
    )

    expect(deps.markHistoryOnly).toHaveBeenCalledWith("job-1", "principal_unbound", { now: T0 })
    expect(deps.bindRequest).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou_1", adapterId: "lk-1", tenantKey: "tk_a" })
    )

    const auditRow = deps.audit.mock.calls[0][0] as Record<string, unknown>
    expect(auditRow.kind).toBe("principal.unbound")
    const fields = auditRow.fields as Record<string, unknown>
    expect(fields.openIdHash).toBe(expectedHash)
    expect(JSON.stringify(auditRow)).not.toContain("ou_1")

    const enqueued = deps.enqueue.mock.calls[0][0] as {
      request: { segments: Array<{ text: string }>; metadata: { idempotencyKey: string } }
    }
    expect(enqueued.request.segments[0].text).toContain("fb_code1")
    // Idempotency key pins the notice to (adapter, senderHash, UTC day).
    expect(enqueued.request.metadata.idempotencyKey).toBe(
      `principal-unbound:lk-1:${expectedHash}:20250720`
    )
  })

  it("stays silent (audit only) for disabled principals", async () => {
    const deps = makeDeps()
    await handleUnresolvedPrincipal(
      event(),
      { id: "lk-1" },
      { status: "principal_disabled", principal: { id: "fp_1" } as never },
      "job-2",
      deps
    )
    expect(deps.markHistoryOnly).toHaveBeenCalledWith("job-2", "principal_principal_disabled", {
      now: T0,
    })
    expect(deps.bindRequest).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
    const auditRow = deps.audit.mock.calls[0][0] as Record<string, unknown>
    expect(auditRow.kind).toBe("principal.rejected")
    expect(auditRow.reason).toBe("principal_disabled")
  })

  it("records the declared account for cross-account rejections without replying", async () => {
    const deps = makeDeps()
    await handleUnresolvedPrincipal(
      event(),
      { id: "lk-1" },
      { status: "cross_account", declaredAccountId: "acct_other" },
      "job-3",
      deps
    )
    expect(deps.enqueue).not.toHaveBeenCalled()
    const auditRow = deps.audit.mock.calls[0][0] as Record<string, unknown>
    expect((auditRow.fields as Record<string, unknown>).declaredAccountId).toBe("acct_other")
  })
})
