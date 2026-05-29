/**
 * Tests for buildLarkA2UICard + parseLarkInteractiveCallback (G3.4).
 */

import "fake-indexeddb/auto"
import { buildLarkA2UICard, segmentsToLarkBodyAsync } from "./card"
import { parseLarkInteractiveCallback } from "./parse"
import type { LarkEventEnvelope } from "./parse"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const baseInput = (surface: A2UISegmentContent) => ({
  adapterId: "adp_lk",
  surfaceId: "sfc_1",
  surface,
  conversationKey: "lark:adp_lk:oc_chat",
})

describe("buildLarkA2UICard", () => {
  it("renders Card title into a header + Buttons into action elements", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Approve?", children: ["b1", "b2"] },
        b1: { id: "b1", component: "Button", text: "Yes", action: "yes", variant: "primary" },
        b2: { id: "b2", component: "Button", text: "No", action: "no", variant: "destructive" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content) as {
      header: { title: { content: string } }
      elements: Array<Record<string, unknown>>
    }
    expect(parsed.header.title.content).toBe("Approve?")
    // The Buttons collapse into a single `action` element with two buttons.
    const actionEl = parsed.elements.find((e) => e.tag === "action") as
      | { actions: Array<Record<string, unknown>> }
      | undefined
    expect(actionEl).toBeDefined()
    expect(actionEl!.actions).toHaveLength(2)
    expect(actionEl!.actions[0]).toMatchObject({ type: "primary", text: { content: "Yes" } })
    expect(actionEl!.actions[1]).toMatchObject({ type: "danger" })
    // Bindings round-trip.
    const binding = await resolveCallbackBinding("adp_lk", "a2ui:sfc_1:b1:yes")
    expect(binding?.componentId).toBe("b1")
    // Plain buttons default to the callback_query kind.
    expect(binding?.kind).toBe("callback_query")
  })

  it("honours a Button's bindingKind + bindingPayload hint (help quick command)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Help", children: ["qc"] },
        qc: {
          id: "qc",
          component: "Button",
          text: "今日日程",
          action: "qc:agenda",
          bindingKind: "help_quick_command",
          bindingPayload: { action: { type: "slash", value: "/lark agenda" } },
        },
      },
      dataModel: {},
      rootId: "root",
    }
    await buildLarkA2UICard(baseInput(surface))
    const binding = await resolveCallbackBinding("adp_lk", "a2ui:sfc_1:qc:qc:agenda")
    expect(binding?.kind).toBe("help_quick_command")
    expect(binding?.payload).toEqual({ action: { type: "slash", value: "/lark agenda" } })
    expect(binding?.conversationKey).toBe("lark:adp_lk:oc_chat")
  })

  it("renders Select with options + DatePicker as native elements", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["sel", "dp"] },
        sel: {
          id: "sel",
          component: "Select",
          value: "",
          label: "Pick",
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ],
        },
        dp: { id: "dp", component: "DatePicker", value: "", label: "When" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    const parsed = JSON.parse(body.content) as {
      elements: Array<{ tag: string; actions?: Array<{ tag: string }> }>
    }
    const tags = parsed.elements.flatMap((e) =>
      e.tag === "action" && e.actions ? e.actions.map((a) => a.tag) : [e.tag]
    )
    expect(tags).toContain("select_static")
    expect(tags).toContain("picker_date")
  })

  // B4 — simulated Checkbox stand-in (ADR-0009 v41).
  it("renders Checkbox as a two-option select_static (simulated tier)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["chk"] },
        chk: { id: "chk", component: "Checkbox", label: "I agree", value: false, action: "agree" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    const parsed = JSON.parse(body.content) as {
      elements: Array<{
        tag: string
        actions?: Array<{
          tag: string
          options?: Array<{ value: string; text: { content: string } }>
          initial_option?: string
          value?: { simulatedCheckbox?: boolean }
        }>
      }>
    }
    const selects = parsed.elements
      .flatMap((e) => e.actions ?? [])
      .filter((a) => a.tag === "select_static")
    expect(selects).toHaveLength(1)
    const sel = selects[0]
    expect(sel.options?.map((o) => o.value).sort()).toEqual(["false", "true"])
    expect(sel.initial_option).toBe("false")
    expect(sel.value?.simulatedCheckbox).toBe(true)
    // Each option's label embeds the field name so the trigger surface
    // tells the user what's being checked.
    expect(sel.options?.[0].text.content).toContain("I agree")
  })

  it("renders Checkbox with initial_option=true when value is truthy", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["chk"] },
        chk: { id: "chk", component: "Checkbox", label: "Subscribe", value: true },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    const parsed = JSON.parse(body.content) as {
      elements: Array<{
        actions?: Array<{ tag: string; initial_option?: string }>
      }>
    }
    const sel = parsed.elements
      .flatMap((e) => e.actions ?? [])
      .find((a) => a.tag === "select_static")
    expect(sel?.initial_option).toBe("true")
  })

  it("renders TextField / TextArea as input elements with appropriate rows", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t", "a"] },
        t: { id: "t", component: "TextField", value: "", label: "Name" },
        a: { id: "a", component: "TextArea", value: "", label: "Body" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    const parsed = JSON.parse(body.content) as {
      elements: Array<{ tag: string; rows?: number }>
    }
    const inputs = parsed.elements.filter((e) => e.tag === "input")
    expect(inputs).toHaveLength(2)
    expect(inputs[0].rows).toBe(1)
    expect(inputs[1].rows).toBe(4)
  })
})

describe("segmentsToLarkBodyAsync — composition with text segments", () => {
  it("collapses text + a2ui into a single interactive card", async () => {
    const a2uiSurface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Survey", children: ["b"] },
        b: { id: "b", component: "Button", text: "Go", action: "go" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await segmentsToLarkBodyAsync(
      [
        { type: "text", text: "Intro paragraph" },
        { type: "a2ui", surfaceId: "sfc_1", content: a2uiSurface, plainTextMirror: "Survey [Go]" },
      ],
      { adapterId: "adp_lk", conversationKey: "lark:adp_lk:oc_chat" }
    )
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content) as {
      header: { title: { content: string } }
      elements: Array<Record<string, unknown>>
    }
    expect(parsed.header.title.content).toBe("Survey")
    // First element is the intro div; later elements contain the action.
    const firstDiv = parsed.elements.find((e) => e.tag === "div") as
      | { text: { content: string } }
      | undefined
    expect(firstDiv?.text.content).toContain("Intro paragraph")
    const action = parsed.elements.find((e) => e.tag === "action")
    expect(action).toBeDefined()
  })

  it("delegates to segmentsToLarkBody when no a2ui segment is present", async () => {
    const body = await segmentsToLarkBodyAsync([{ type: "text", text: "just text" }], {
      adapterId: "adp_lk",
    })
    expect(body.msg_type).toBe("text")
    expect(JSON.parse(body.content)).toEqual({ text: "just text" })
  })
})

describe("parseLarkInteractiveCallback", () => {
  it("projects a button press into a ConnectorCallbackEvent", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: {
        event_id: "evt_001",
        event_type: "im.interactive_message.action_triggered_v1",
        create_time: "1700000000000",
      },
      event: {
        operator: { open_id: "ou_user1" },
        open_chat_id: "oc_chat",
        open_message_id: "om_msg",
        action: {
          tag: "button",
          value: {
            actionId: "a2ui:sfc_1:b1:yes",
            surfaceId: "sfc_1",
            componentId: "b1",
          },
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT_OPEN_ID", envelope)
    expect(cb!.actionType).toBe("button")
    expect(cb!.triggerId).toBe("a2ui:sfc_1:b1:yes")
    expect(cb!.surfaceId).toBe("sfc_1")
    expect(cb!.componentId).toBe("b1")
    expect(cb!.conversationKey).toBe("lark:adp_lk:oc_chat")
    expect(cb!.user.remoteUserId).toBe("ou_user1")
  })

  // B4 — when the mapper marks a select_static value with
  // simulatedCheckbox:true, the parser lifts it back into a real
  // checkbox event so the bridge doesn't need to know about Lark's
  // stand-in encoding.
  it("simulated checkbox select_static lifts to actionType=checkbox + boolean value", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: {
        event_id: "evt_chk",
        event_type: "im.interactive_message.action_triggered_v1",
      },
      event: {
        operator: { open_id: "ou_user1" },
        open_chat_id: "oc_chat",
        action: {
          tag: "select_static",
          value: {
            actionId: "a2ui:sfc:chk:agree",
            surfaceId: "sfc",
            componentId: "chk",
            simulatedCheckbox: true,
          },
          option: "true",
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("checkbox")
    expect(cb!.value).toBe("true")
  })

  it("simulated checkbox returns 'false' when the selected option is anything other than 'true'", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: { event_id: "evt_chk_2", event_type: "im.interactive_message.action_triggered_v1" },
      event: {
        operator: { open_id: "ou_user1" },
        open_chat_id: "oc_chat",
        action: {
          tag: "select_static",
          value: {
            actionId: "a2ui:sfc:chk:agree",
            surfaceId: "sfc",
            componentId: "chk",
            simulatedCheckbox: true,
          },
          option: "false",
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("checkbox")
    expect(cb!.value).toBe("false")
  })

  it("select_static produces actionType=select with option as value", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: {
        event_id: "evt_002",
        event_type: "im.interactive_message.action_triggered_v1",
      },
      event: {
        operator: { open_id: "ou_user1" },
        open_chat_id: "oc_chat",
        action: {
          tag: "select_static",
          value: { actionId: "a2ui:sfc:sel:pick", surfaceId: "sfc", componentId: "sel" },
          option: "alpha",
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("select")
    expect(cb!.value).toBe("alpha")
  })

  it("returns null for non-interactive event types", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: { event_id: "x", event_type: "im.message.receive_v1" },
      event: {},
    }
    expect(parseLarkInteractiveCallback("adp_lk", "BOT", envelope)).toBeNull()
  })
})
