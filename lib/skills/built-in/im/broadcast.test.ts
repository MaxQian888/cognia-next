jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPiiDeep: jest.fn(() => true),
}))

jest.mock("@/lib/connectors/session-bindings", () => ({
  findSessionByConversationKey: jest.fn(),
}))

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "job" }),
}))

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn().mockResolvedValue(undefined),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./broadcast"
import { hasNoLeakingPiiDeep } from "@/lib/twin/ingest/redact"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"

const mPii = hasNoLeakingPiiDeep as jest.Mock
const mFind = findSessionByConversationKey as jest.Mock
const mEnqueue = enqueueOutbound as jest.Mock
const mAudit = appendAudit as jest.Mock

function skill() {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === "im.broadcast")
  if (!s) throw new Error("im.broadcast not registered")
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mPii.mockReturnValue(true)
  mFind.mockResolvedValue({
    id: "s1",
    platformBinding: {
      conversationRef: { platform: "lark", adapterId: "a1", channelId: "oc_1" },
    },
  })
})

describe("im.broadcast", () => {
  it("fans out to every target with a DISTINCT idempotency key", async () => {
    const keys = ["lark:a1:oc_1", "lark:a1:oc_2", "telegram:a2:chat_9"]
    const out = (await skill().execute(
      { conversationKeys: keys, message: "release shipped" },
      { sessionId: "s" }
    )) as { enqueued: number; skipped: number }
    expect(out).toMatchObject({ enqueued: 3, skipped: 0 })
    expect(mEnqueue).toHaveBeenCalledTimes(3)
    const idemKeys = mEnqueue.mock.calls.map(
      (c) =>
        (c[0] as { request: { metadata: { idempotencyKey: string } } }).request.metadata
          .idempotencyKey
    )
    expect(new Set(idemKeys).size).toBe(3)
    // Per-target adapterId parsed from the key, source stamped "skill".
    expect(mEnqueue.mock.calls[2][0]).toMatchObject({ adapterId: "a2", source: "skill" })
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "broadcast.enqueued",
        fields: { targetCount: 3, enqueued: 3, skipped: 0 },
      })
    )
  })

  it("denies PII-leaking content before ANY enqueue", async () => {
    mPii.mockReturnValue(false)
    const out = (await skill().execute(
      { conversationKeys: ["lark:a1:oc_1"], message: "alice@corp.com" },
      { sessionId: "s" }
    )) as { status: string; reason: string }
    expect(out).toMatchObject({ status: "denied", reason: "pii_blocked" })
    expect(mEnqueue).not.toHaveBeenCalled()
  })

  it("skips-and-reports invalid keys and unbound conversations, auditing partial failure", async () => {
    mFind.mockImplementation(async (key: string) =>
      key === "lark:a1:oc_ok"
        ? { id: "s1", platformBinding: { conversationRef: { platform: "lark", adapterId: "a1" } } }
        : undefined
    )
    const out = (await skill().execute(
      { conversationKeys: ["not-a-key", "lark:a1:oc_ok", "lark:a1:oc_unbound"], message: "hi" },
      { sessionId: "s" }
    )) as { enqueued: number; skipped: number; outcomes: Array<{ reason?: string }> }
    expect(out.enqueued).toBe(1)
    expect(out.skipped).toBe(2)
    expect(out.outcomes.map((o) => o.reason)).toEqual([
      "invalid_key",
      undefined,
      "no_bound_session",
    ])
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "broadcast.partial_failure" })
    )
  })

  it("reuses the bound session's conversationRef when available", async () => {
    await skill().execute({ conversationKeys: ["lark:a1:oc_1"], message: "hi" }, { sessionId: "s" })
    expect(mEnqueue.mock.calls[0][0]).toMatchObject({
      request: {
        conversationRef: { platform: "lark", adapterId: "a1", channelId: "oc_1" },
      },
    })
  })
})
