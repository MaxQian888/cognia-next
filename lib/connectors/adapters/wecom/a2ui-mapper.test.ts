/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  buildWeComTemplateCard,
  parseTemplateCardEvent,
  parseActionId,
  buildAckUpdateCard,
} from "./a2ui-mapper"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import type { WeComInboundEventBody } from "./protocol"

function surface(): A2UIMessageSegment {
  return {
    type: "a2ui",
    surfaceId: "sfc1",
    content: {
      rootId: "root",
      dataModel: {},
      components: {
        root: { id: "root", component: "Card", title: "Pick one", children: ["b1", "b2"] },
        b1: { id: "b1", component: "Button", text: "Yes", action: "approve" },
        b2: { id: "b2", component: "Button", text: "No", action: "reject" },
      },
    },
    plainTextMirror: "Pick one [Yes] [No]",
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("buildWeComTemplateCard", () => {
  it("maps Card + Buttons to a button_interaction card and records bindings", async () => {
    const card = await buildWeComTemplateCard("adp", surface(), "wecom:adp:c1")
    expect(card).not.toBeNull()
    expect(card!.card_type).toBe("button_interaction")
    expect(card!.main_title?.title).toBe("Pick one")
    expect(card!.button_list).toEqual([
      { key: "a2ui:sfc1:b1:approve", text: "Yes", style: 1 },
      { key: "a2ui:sfc1:b2:reject", text: "No", style: 1 },
    ])

    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toMatchObject({
      adapterId: "adp",
      surfaceId: "sfc1",
      conversationKey: "wecom:adp:c1",
    })
  })

  it("returns null for a surface with no buttons", async () => {
    const noButtons: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s2",
      content: {
        rootId: "root",
        dataModel: {},
        components: { root: { id: "root", component: "Text", text: "just text" } },
      },
      plainTextMirror: "just text",
    }
    expect(await buildWeComTemplateCard("adp", noButtons)).toBeNull()
  })
})

describe("parseActionId", () => {
  it("splits the namespaced action id", () => {
    expect(parseActionId("a2ui:sfc1:b1:approve")).toEqual({
      surfaceId: "sfc1",
      componentId: "b1",
      action: "approve",
    })
  })
  it("returns null for non-a2ui ids", () => {
    expect(parseActionId("random")).toBeNull()
  })
})

describe("parseTemplateCardEvent", () => {
  function event(eventKey?: string): WeComInboundEventBody {
    return {
      aibotid: "self",
      chatid: "c1",
      from: { userid: "u_alice", name: "Alice" },
      msgtype: "event",
      event: { eventtype: "template_card_event", template_card: { event_key: eventKey } },
    }
  }

  it("projects a card click into a ConnectorCallbackEvent (triggerId = action id)", () => {
    const cb = parseTemplateCardEvent("adp", "self", event("a2ui:sfc1:b1:approve"), 999)
    expect(cb).not.toBeNull()
    expect(cb).toMatchObject({
      platform: "wecom",
      adapterId: "adp",
      triggerId: "a2ui:sfc1:b1:approve",
      surfaceId: "sfc1",
      componentId: "b1",
      actionType: "button",
      value: "approve",
      conversationKey: "wecom:adp:c1",
      timestamp: 999,
    })
    expect(cb!.user.remoteUserId).toBe("u_alice")
  })

  it("returns null when the event key is missing", () => {
    expect(parseTemplateCardEvent("adp", "self", event(undefined))).toBeNull()
  })

  it("returns null for non-card events", () => {
    const enter: WeComInboundEventBody = {
      aibotid: "self",
      msgtype: "event",
      event: { eventtype: "enter_chat" },
    }
    expect(parseTemplateCardEvent("adp", "self", enter)).toBeNull()
  })
})

describe("buildAckUpdateCard", () => {
  it("preserves the task_id and sets the ack text", () => {
    const body: WeComInboundEventBody = {
      aibotid: "self",
      msgtype: "event",
      event: { eventtype: "template_card_event", template_card: { task_id: "t9" } },
    }
    const card = buildAckUpdateCard(body, "✓")
    expect(card.task_id).toBe("t9")
    expect(card.main_title?.title).toBe("✓")
  })
})
