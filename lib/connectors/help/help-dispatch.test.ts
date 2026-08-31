import { maybeHandleHelpCommand, maybeSendWelcome } from "./help-dispatch"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function makeEvent(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "ad1",
    selfId: "bot",
    messageId: "m1",
    conversationRef: { platform: "lark", adapterId: "ad1", channelId: "oc_1" },
    conversationKey: "lark:ad1:oc_1",
    sender: { id: "lark:u1", platform: "lark", adapterId: "ad1", remoteUserId: "u1" },
    channel: { id: "lark:ad1:oc_1", kind: "group", platformChannelId: "oc_1" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1000,
    raw: {},
    kind: "create",
    ...over,
  }
}

function makeRow(over: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "ad1",
    type: "lark",
    displayName: "Cognia",
    enabled: true,
    transportMode: "gateway",
    mediaModelPolicy: "local_extract_only",
    settings: { quickCommands: [{ triggerKey: "agenda", action: { type: "slash", value: "/x" } }] },
    credentialsRef: { keyringService: "s", accounts: [] },
    trigger: {} as never,
    defaultMode: "auto" as never,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function deps(override: Record<string, unknown> | undefined = undefined) {
  const enqueue = jest.fn().mockResolvedValue({ id: "job" })
  const audit = jest.fn().mockResolvedValue({})
  // Injected so the behaviour disclosure is deterministic. Without it the
  // production `readForResolution` reaches for Dexie, which the node project
  // has no database for, and the read is swallowed by its own catch.
  const readOverride = jest.fn().mockResolvedValue(override)
  return { enqueue, audit, now: () => 5000, readOverride } as never
}

/** The plain-text mirror of the single card the dispatcher enqueued. */
function cardText(enqueue: jest.Mock): string {
  const segment = enqueue.mock.calls[0][0].request.segments[0]
  return (segment.plainTextMirror ?? segment.text ?? "") as string
}

describe("maybeHandleHelpCommand — behaviour disclosure", () => {
  // The card used to promise a reply the bot would never send. It reads the
  // conversation's own axes, so a channel the operator silenced says so even
  // when the bot answers everywhere else.
  it("says a silenced conversation is answered by a person", async () => {
    const d = deps({ autonomy: "observe", engagement: "human" })
    await maybeHandleHelpCommand(makeEvent({ plainText: "/help" }), makeRow(), d)
    const text = cardText((d as unknown as { enqueue: jest.Mock }).enqueue)
    expect(text).toContain("由人来回答")
  })

  it("says a draft conversation holds the reply for a human", async () => {
    const d = deps({ autonomy: "suggest" })
    await maybeHandleHelpCommand(makeEvent({ plainText: "/help" }), makeRow(), d)
    const text = cardText((d as unknown as { enqueue: jest.Mock }).enqueue)
    expect(text).toContain("等人确认")
  })

  // A conversation that pinned only the legacy mirror MEANS that mode, so its
  // pin has to suppress the bot's axis defaults rather than mix with them.
  it("lets a conversation's legacy mode pin outrank the bot's axis default", async () => {
    const d = deps({ mode: "manual" })
    await maybeHandleHelpCommand(
      makeEvent({ plainText: "/help" }),
      makeRow({ defaultAutonomy: "act" } as never),
      d
    )
    expect(cardText((d as unknown as { enqueue: jest.Mock }).enqueue)).toContain("由人来回答")
  })

  it("adds no note for a bot that answers on its own", async () => {
    const d = deps()
    await maybeHandleHelpCommand(makeEvent({ plainText: "/help" }), makeRow(), d)
    const text = cardText((d as unknown as { enqueue: jest.Mock }).enqueue)
    expect(text).not.toContain("我会怎么处理")
  })
})

describe("maybeHandleHelpCommand", () => {
  it("serves a help card and returns true on a default trigger", async () => {
    const d = deps()
    const handled = await maybeHandleHelpCommand(makeEvent({ plainText: " /HELP " }), makeRow(), d)
    expect(handled).toBe(true)
    expect(d.enqueue).toHaveBeenCalledTimes(1)
    const arg = d.enqueue.mock.calls[0][0]
    expect(arg.adapterId).toBe("ad1")
    expect(arg.conversationKey).toBe("lark:ad1:oc_1")
    expect(arg.request.segments[0].type).toBe("a2ui")
    expect(arg.source).toBe("ai-run")
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbound.help_served", at: 5000 })
    )
  })

  it("matches the Chinese default trigger 帮助", async () => {
    const d = deps()
    expect(await maybeHandleHelpCommand(makeEvent({ plainText: "帮助" }), makeRow(), d)).toBe(true)
  })

  it("honours operator-configured custom triggers and ignores defaults then", async () => {
    const d = deps()
    const row = makeRow({ helpTriggers: ["menu"] })
    expect(await maybeHandleHelpCommand(makeEvent({ plainText: "/help" }), row, d)).toBe(false)
    expect(await maybeHandleHelpCommand(makeEvent({ plainText: "MENU" }), row, d)).toBe(true)
  })

  it("returns false for non-create events", async () => {
    const d = deps()
    const ev = makeEvent({ plainText: "/help", kind: "edit" })
    expect(await maybeHandleHelpCommand(ev, makeRow(), d)).toBe(false)
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it("returns false for a non-trigger message", async () => {
    const d = deps()
    expect(
      await maybeHandleHelpCommand(makeEvent({ plainText: "what time is it" }), makeRow(), d)
    ).toBe(false)
    expect(d.enqueue).not.toHaveBeenCalled()
  })
})

describe("maybeSendWelcome", () => {
  it("sends once and audits welcome_sent when the conversation is new", async () => {
    const d = deps()
    const recordWelcome = jest.fn().mockResolvedValue(true)
    const sent = await maybeSendWelcome(
      makeEvent({ systemKind: "member_added", kind: "system" }),
      makeRow(),
      {
        ...d,
        recordWelcome,
      }
    )
    expect(sent).toBe(true)
    expect(recordWelcome).toHaveBeenCalledWith("ad1", "lark:ad1:oc_1")
    expect(d.enqueue).toHaveBeenCalledTimes(1)
    expect(d.enqueue.mock.calls[0][0].request.metadata.idempotencyKey).toBe("welcome:lark:ad1:oc_1")
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "inbound.welcome_sent" }))
  })

  it("does not re-send when the conversation was already welcomed", async () => {
    const d = deps()
    const recordWelcome = jest.fn().mockResolvedValue(false)
    const sent = await maybeSendWelcome(makeEvent(), makeRow(), { ...d, recordWelcome })
    expect(sent).toBe(false)
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it("is a no-op when welcomeCardEnabled is false", async () => {
    const d = deps()
    const recordWelcome = jest.fn().mockResolvedValue(true)
    const sent = await maybeSendWelcome(makeEvent(), makeRow({ welcomeCardEnabled: false }), {
      ...d,
      recordWelcome,
    })
    expect(sent).toBe(false)
    expect(recordWelcome).not.toHaveBeenCalled()
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it("uses operator welcomeText in the surface mirror", async () => {
    const d = deps()
    const recordWelcome = jest.fn().mockResolvedValue(true)
    await maybeSendWelcome(makeEvent(), makeRow({ welcomeText: "欢迎光临" }), {
      ...d,
      recordWelcome,
    })
    const seg = d.enqueue.mock.calls[0][0].request.segments[0]
    expect(seg.plainTextMirror).toContain("欢迎光临")
  })
})
