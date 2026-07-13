/**
 * Tests for lib/notifications/im-deliver.ts — the IM proactive-push channel.
 */

import { createImDeliver } from "./im-deliver"
import type { NotificationRecord } from "@/types/notifications"
import type { ChatSession } from "@cognia/agent-config-types"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    source: "connector",
    level: "info",
    title: "Task done",
    body: "Your build finished.",
    createdAt: 0,
    updatedAt: 0,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    sourceRef: { kind: "conversation", id: "telegram:tg-1:9" },
    ...over,
  }
}

function session(): ChatSession {
  return {
    id: "s1",
    title: "t",
    kind: "direct",
    platformConversationKey: "telegram:tg-1:9",
    platformBinding: {
      platform: "telegram",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: "9" },
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

interface Harness {
  enqueued: Array<{ adapterId: string; conversationKey: string; idempotencyKey?: string }>
  audits: string[]
  deps: Parameters<typeof createImDeliver>[0]
}

function harness(opts: {
  hasSession?: boolean
  proactivePush?: boolean
  piiSafe?: boolean
}): Harness {
  const enqueued: Harness["enqueued"] = []
  const audits: string[] = []
  const deps = {
    findSession: (async () => (opts.hasSession === false ? undefined : session())) as NonNullable<
      Harness["deps"]
    >["findSession"],
    readOverride: (async () =>
      opts.proactivePush === undefined
        ? undefined
        : { proactivePush: opts.proactivePush }) as NonNullable<Harness["deps"]>["readOverride"],
    enqueue: (async (job: {
      adapterId: string
      conversationKey: string
      request: { metadata?: { idempotencyKey?: string } }
    }) => {
      enqueued.push({
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        idempotencyKey: job.request.metadata?.idempotencyKey,
      })
    }) as unknown as NonNullable<Harness["deps"]>["enqueue"],
    audit: (async (e: { kind: string }) => {
      audits.push(e.kind)
    }) as unknown as NonNullable<Harness["deps"]>["audit"],
    isPiiSafe: () => opts.piiSafe ?? true,
  }
  return { enqueued, audits, deps }
}

describe("createImDeliver", () => {
  it("enqueues a text push when opted in + PII-safe", async () => {
    const h = harness({ proactivePush: true, piiSafe: true })
    await createImDeliver(h.deps)(rec())
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toMatchObject({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      idempotencyKey: "notify:n1",
    })
    expect(h.audits).toContain("notify.im_pushed")
  })

  it("skips (no enqueue) when the conversation has not opted in", async () => {
    const h = harness({ proactivePush: false })
    await createImDeliver(h.deps)(rec())
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_skipped")
  })

  it("skips when no opt-in row exists at all (fail-closed default off)", async () => {
    const h = harness({ proactivePush: undefined })
    await createImDeliver(h.deps)(rec())
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_skipped")
  })

  it("blocks + audits when the body fails the PII gate", async () => {
    const h = harness({ proactivePush: true, piiSafe: false })
    await createImDeliver(h.deps)(rec({ body: "card 4111 1111 1111 1111" }))
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_pii_blocked")
  })

  it("does nothing for a record not targeted at a conversation", async () => {
    const h = harness({ proactivePush: true })
    await createImDeliver(h.deps)(rec({ sourceRef: { kind: "run", id: "x" } }))
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })

  it("does nothing when no bound session resolves the target", async () => {
    const h = harness({ hasSession: false, proactivePush: true })
    await createImDeliver(h.deps)(rec())
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })

  it("never throws when a dependency rejects (fail-closed)", async () => {
    const deps = {
      findSession: async () => {
        throw new Error("dexie down")
      },
    } as Parameters<typeof createImDeliver>[0]
    await expect(createImDeliver(deps)(rec())).resolves.toBeUndefined()
  })
})
