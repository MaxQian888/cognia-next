import type { IMQuickCommand } from "@/lib/connectors/quick-commands/types"
import type { WeComInboundEventBody } from "./protocol"
import type { WeComConversationRef } from "./parse"
import {
  QC_KEY_PREFIX,
  buildMenuClickInboundEvent,
  buildWeComMenuCard,
  parseMenuButtonClick,
} from "./menu-card"

const sampleCommands: IMQuickCommand[] = [
  { triggerKey: "help", label: "Help", action: { type: "prompt", value: "show help" } },
  { triggerKey: "report.run", action: { type: "slash", value: "/report run" } },
]

describe("buildWeComMenuCard", () => {
  it("returns null when the command list is empty", () => {
    expect(buildWeComMenuCard([])).toBeNull()
  })

  it("renders one button per command with qc-prefixed keys", () => {
    const card = buildWeComMenuCard(sampleCommands)
    if (!card) throw new Error("expected a non-null card")
    expect(card.button_list ?? []).toHaveLength(2)
    expect(card.button_list?.[0]?.key).toBe(`${QC_KEY_PREFIX}help`)
    expect(card.button_list?.[0]?.text).toBe("Help")
    expect(card.button_list?.[1]?.key).toBe(`${QC_KEY_PREFIX}report.run`)
    expect(card.button_list?.[1]?.text).toBe("report.run") // no label → triggerKey
  })

  it("caps buttons at the protocol limit (6)", () => {
    const overflow: IMQuickCommand[] = Array.from({ length: 10 }, (_, i) => ({
      triggerKey: `key${i}`,
      action: { type: "prompt" as const, value: "x" },
    }))
    const card = buildWeComMenuCard(overflow)
    expect(card?.button_list ?? []).toHaveLength(6)
  })

  it("uses provided title / desc when supplied", () => {
    const card = buildWeComMenuCard(sampleCommands, { title: "Menu", desc: "tap one" })
    if (!card) throw new Error("expected a non-null card")
    expect(card.main_title?.title).toBe("Menu")
    expect(card.main_title?.desc).toBe("tap one")
  })

  it("uses a neutral Chinese default title", () => {
    const card = buildWeComMenuCard(sampleCommands)
    expect(card?.main_title?.title).toBe("选择一个操作")
  })

  it("never collides with a2ui:, wfapp:, or wfcan: namespaces", () => {
    const card = buildWeComMenuCard(sampleCommands)
    for (const btn of card?.button_list ?? []) {
      expect(btn.key.startsWith("a2ui:")).toBe(false)
      expect(btn.key.startsWith("wfapp:")).toBe(false)
      expect(btn.key.startsWith("wfcan:")).toBe(false)
      expect(btn.key.startsWith("qc:")).toBe(true)
    }
  })
})

describe("parseMenuButtonClick", () => {
  function makeEvent(key: string | undefined): WeComInboundEventBody {
    return {
      aibotid: "ab1",
      event: {
        eventtype: "template_card_event",
        template_card: key ? { event_key: key, task_id: "t1" } : { task_id: "t1" },
      },
    } as WeComInboundEventBody
  }

  it("extracts the triggerKey when prefix matches", () => {
    expect(parseMenuButtonClick(makeEvent("qc:help"))).toEqual({ triggerKey: "help" })
  })

  it("returns null when prefix does not match (a2ui:, wfapp:, etc.)", () => {
    expect(parseMenuButtonClick(makeEvent("a2ui:sfc:btn:do"))).toBeNull()
    expect(parseMenuButtonClick(makeEvent("wfapp:abc"))).toBeNull()
  })

  it("returns null for events without an event_key", () => {
    expect(parseMenuButtonClick(makeEvent(undefined))).toBeNull()
  })

  it("returns null for non-template_card events", () => {
    const body = {
      aibotid: "ab1",
      event: { eventtype: "enter_chat" },
    } as unknown as WeComInboundEventBody
    expect(parseMenuButtonClick(body)).toBeNull()
  })
})

describe("buildMenuClickInboundEvent", () => {
  const command: IMQuickCommand = {
    triggerKey: "help",
    label: "Help",
    action: { type: "prompt", value: "show help" },
  }

  function makeBody(): WeComInboundEventBody {
    return {
      msgid: "msg-1",
      aibotid: "ab1",
      chatid: "chat-9",
      chattype: "group",
      from: { userid: "u1", name: "Alice" },
      msgtype: "event",
      event: {
        eventtype: "template_card_event",
        template_card: { event_key: "qc:help", task_id: "t1" },
      },
    }
  }

  it("builds a FULL WeCom conversationRef (chatId / chatType / userId / reqId)", () => {
    const event = buildMenuClickInboundEvent("adp1", "self1", makeBody(), command, "req-77", 123)
    expect(event).not.toBeNull()
    const ref = event!.conversationRef as WeComConversationRef
    expect(ref).toEqual({
      platform: "wecom",
      adapterId: "adp1",
      chatId: "chat-9",
      chatType: "group",
      userId: "u1",
      reqId: "req-77",
      sourceMsgId: "msg-1",
    })
    expect(event!.plainText).toBe("show help")
  })

  it("defaults chatType to single when the event omits chattype", () => {
    const body = makeBody()
    delete body.chattype
    const event = buildMenuClickInboundEvent("adp1", "self1", body, command)
    const ref = event!.conversationRef as WeComConversationRef
    expect(ref.chatType).toBe("single")
    expect(ref.reqId).toBeUndefined()
  })

  it("returns null when the event carries no chatid", () => {
    const body = makeBody()
    delete body.chatid
    expect(buildMenuClickInboundEvent("adp1", "self1", body, command, "r")).toBeNull()
  })
})
