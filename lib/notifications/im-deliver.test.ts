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
      deliveryTarget: {
        address: {
          conversationKey: "telegram:tg-1:9",
          platform: "telegram",
          adapterId: "tg-1",
          scopeKind: "private",
          containerId: "9",
        },
        conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: "9" },
        refreshedAt: 0,
      },
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

interface Harness {
  enqueued: Array<{
    adapterId: string
    conversationKey: string
    idempotencyKey?: string
    segments: Array<Record<string, unknown>>
  }>
  audits: string[]
  deps: Parameters<typeof createImDeliver>[0]
}

function harness(opts: {
  hasSession?: boolean
  proactivePush?: boolean
  piiSafe?: boolean
  /** Session rows the `session` / `groupKey` resolution step can find. */
  sessions?: Record<string, { platformBinding?: { conversationKey?: string } }>
  /** Run bindings the run-kind resolution step can find. */
  runBindings?: Record<string, Array<{ conversationKey?: string }>>
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
      request: {
        metadata?: { idempotencyKey?: string }
        segments: Array<Record<string, unknown>>
      }
    }) => {
      enqueued.push({
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        idempotencyKey: job.request.metadata?.idempotencyKey,
        segments: job.request.segments,
      })
    }) as unknown as NonNullable<Harness["deps"]>["enqueue"],
    audit: (async (e: { kind: string }) => {
      audits.push(e.kind)
    }) as unknown as NonNullable<Harness["deps"]>["audit"],
    isPiiSafe: () => opts.piiSafe ?? true,
    getSession: (async (id: string) => opts.sessions?.[id]) as NonNullable<
      Harness["deps"]
    >["getSession"],
    listRunBindings: (async (runId: string) =>
      opts.runBindings?.[runId] ?? []) as unknown as NonNullable<
      Harness["deps"]
    >["listRunBindings"],
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

// ---------------------------------------------------------------------------
// Conversation resolution: which records can reach IM at all
// ---------------------------------------------------------------------------

describe("createImDeliver: conversation resolution", () => {
  const boundSession = { platformBinding: { conversationKey: "telegram:tg-1:9" } }

  // The gate was `sourceRef.kind === "conversation"` and a silent return, so a
  // plan awaiting approval was invisible in IM by construction, with nothing
  // recorded to say why. The plan hub sets `groupKey` to the plan's session id.
  it("reaches IM for a plan, through the session its groupKey names", async () => {
    const h = harness({
      proactivePush: true,
      sessions: { s1: boundSession },
    })
    await createImDeliver(h.deps)(
      rec({ sourceRef: { kind: "plan", id: "plan_1" }, groupKey: "s1" })
    )
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0].conversationKey).toBe("telegram:tg-1:9")
  })

  it("reaches IM for a session-scoped record", async () => {
    const h = harness({ proactivePush: true, sessions: { s1: boundSession } })
    await createImDeliver(h.deps)(rec({ sourceRef: { kind: "session", id: "s1" } }))
    expect(h.enqueued).toHaveLength(1)
  })

  // A run knows the conversation that started it, because the binding is
  // minted with the conversation key when the run is dispatched from IM.
  it.each(["run", "team-run", "background-run"])(
    "reaches IM for a %s through its execution-run binding",
    async (kind) => {
      const h = harness({
        proactivePush: true,
        runBindings: { r1: [{ conversationKey: "telegram:tg-1:9" }] },
      })
      await createImDeliver(h.deps)(rec({ sourceRef: { kind, id: "r1" } }))
      expect(h.enqueued).toHaveLength(1)
    }
  )

  // A run started on the desktop has no binding, and a record naming nothing
  // resolves to nothing. Widening WHERE a push can land must not widen WHETHER
  // one happens.
  it("stays quiet for a run that never came from IM", async () => {
    const h = harness({ proactivePush: true, runBindings: { r1: [{}] } })
    await createImDeliver(h.deps)(rec({ sourceRef: { kind: "run", id: "r1" } }))
    expect(h.enqueued).toHaveLength(0)
  })

  it("stays quiet for a record that names no entity at all", async () => {
    const h = harness({ proactivePush: true })
    await createImDeliver(h.deps)(rec({ sourceRef: undefined, groupKey: undefined }))
    expect(h.enqueued).toHaveLength(0)
  })

  // The opt-in is the only thing that decides whether a push happens, and it
  // is untouched by the wider resolution.
  it("still honours the fail-closed opt-in on a newly reachable record", async () => {
    const h = harness({ proactivePush: false, sessions: { s1: boundSession } })
    await createImDeliver(h.deps)(
      rec({ sourceRef: { kind: "plan", id: "plan_1" }, groupKey: "s1" })
    )
    expect(h.enqueued).toHaveLength(0)
    expect(h.audits).toContain("notify.im_skipped")
  })
})

// ---------------------------------------------------------------------------
// Actions: a question needs its answers attached
// ---------------------------------------------------------------------------

describe("createImDeliver: action buttons", () => {
  const approve = {
    id: "approve",
    label: "Approve",
    command: "plan.approval.respond",
    args: { planId: "p1", decision: "approve" },
    variant: "primary" as const,
  }

  it("sends an A2UI card carrying the record's actions", async () => {
    const h = harness({ proactivePush: true })
    await createImDeliver(h.deps)(rec({ actions: [approve] }))
    const segment = h.enqueued[0].segments[0] as {
      type: string
      content: { components: Record<string, Record<string, unknown>> }
    }
    expect(segment.type).toBe("a2ui")
    const button = segment.content.components.action_approve
    expect(button.component).toBe("Button")
    expect(button.bindingKind).toBe("notification_action")
    // The command and its args stay on the centre row: a card is pressable
    // long after it was sent, so baking them in would let a stale card run
    // work the record no longer offers.
    expect(button.bindingPayload).toEqual({ notificationId: "n1", actionId: "approve" })
  })

  // A record with no actions is a statement, and the plain-text path renders
  // it better on every platform.
  it("keeps the plain-text path for a record with no actions", async () => {
    const h = harness({ proactivePush: true })
    await createImDeliver(h.deps)(rec())
    expect(h.enqueued[0].segments[0]).toMatchObject({ type: "text" })
  })
})
