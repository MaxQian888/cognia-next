/** @jest-environment jsdom */
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
import { assistantReplyToSegments } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"

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
  it("renders bound descriptions, canonical alert messages, and footer actions", async () => {
    const body = await buildLarkA2UICard(
      baseInput({
        rootId: "root",
        dataModel: { summary: "Project summary", status: "Ready to review" },
        components: {
          root: {
            component: "Card",
            title: "Report",
            description: { path: "/summary" },
            children: ["alert"],
            footer: ["go"],
          },
          alert: { component: "Alert", message: { path: "/status" } },
          go: { component: "Button", text: "Review", action: "review" },
        },
      })
    )
    expect(body.content).toContain("Project summary")
    expect(body.content).toContain("Ready to review")
    expect(body.content).toContain('"tag":"button"')
  })

  it("renders an assistant's fenced A2UI as native card elements with a working callback", async () => {
    const segments = assistantReplyToSegments({
      text: `项目速览：\n\`\`\`a2ui\n${JSON.stringify({
        surface: { id: "cognia-analysis", type: "inline", title: "Cognia Next 分析" },
        components: [
          { id: "root", component: "Column", children: ["title", "go"] },
          { id: "title", component: "Text", text: "Cognia Next 项目速览" },
          { id: "go", component: "Button", text: "继续", action: "continue" },
        ],
      })}\n\`\`\`\n分析完成。`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    const body = await segmentsToLarkBodyAsync(segments, {
      adapterId: "adp_lk",
      conversationKey: "lark:adp_lk:oc_chat",
    })
    expect(body.msg_type).toBe("interactive")
    expect(body.content).toContain("Cognia Next 项目速览")
    expect(body.content).toContain('"tag":"button"')
    expect(body.content).not.toContain("```a2ui")
    expect(body.content).not.toContain('"component":"Column"')
    expect(
      await resolveCallbackBinding("adp_lk", "a2ui:cognia-analysis:go:continue")
    ).toMatchObject({
      surfaceId: "cognia-analysis",
      componentId: "go",
    })
  })

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
    const parsed = JSON.parse(body.content)
    expect(parsed.header.title.content).toBe("Approve?")
    expect(parsed.schema).toBe("2.0")
    expect(parsed.body.elements).toHaveLength(2)
    expect(parsed.body.elements[0]).toMatchObject({
      tag: "button",
      type: "primary",
      text: { content: "Yes" },
    })
    expect(parsed.body.elements[1]).toMatchObject({ tag: "button", type: "danger" })
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
    const parsed = JSON.parse(body.content)
    const tags = parsed.body.elements.map((e: { tag: string }) => e.tag)
    expect(tags).toContain("select_static")
    expect(tags).toContain("picker_date")
  })

  it("renders native checker with canonical checked binding and legacy value", async () => {
    for (const raw of [{ checked: true, value: false }, { value: true }, { checked: false }]) {
      const body = await buildLarkA2UICard(
        baseInput({
          rootId: "chk",
          dataModel: {},
          components: { chk: { component: "Checkbox", label: "Agree", ...raw } },
        })
      )
      const card = JSON.parse(body.content)
      expect(card.body.elements[0]).toMatchObject({
        tag: "checker",
        checked: raw.checked ?? raw.value ?? false,
        text: { content: "Agree" },
      })
    }
  })

  it("renders direct Card 2.0 inputs with real multiline text", async () => {
    const body = await buildLarkA2UICard(
      baseInput({
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Column", children: ["t", "a"] },
          t: { component: "TextField", label: "Name", required: true },
          a: { component: "TextArea", label: "Body", rows: 3 },
        },
      })
    )
    const elements = JSON.parse(body.content).body.elements
    expect(elements).toHaveLength(2)
    expect(elements[0]).toMatchObject({ tag: "input", input_type: "text" })
    expect(elements[0].required).toBeUndefined()
    expect(elements[1]).toMatchObject({ tag: "input", input_type: "multiline_text", rows: 3 })
    expect(elements[0].behaviors[0].value.componentId).toBe("t")
    expect(await resolveCallbackBinding("adp_lk", "a2ui:sfc_1:t:t")).toMatchObject({
      componentId: "t",
    })
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
    const parsed = JSON.parse(body.content)
    expect(parsed.header.title.content).toBe("Survey")
    expect(parsed.body.elements[0]).toMatchObject({ tag: "markdown", content: "Intro paragraph" })
    expect(parsed.body.elements.some((e: { tag: string }) => e.tag === "button")).toBe(true)
  })

  it("delegates to segmentsToLarkBody when no a2ui segment is present", async () => {
    const body = await segmentsToLarkBodyAsync([{ type: "text", text: "just text" }], {
      adapterId: "adp_lk",
    })
    expect(body.msg_type).toBe("text")
    expect(JSON.parse(body.content)).toEqual({ text: "just text" })
  })

  // Multi-segment messages containing markdown used to degrade every
  // non-text segment to "[type]" placeholders (literally sending the string
  // "[markdown]"). Markdown renders via a card md element, so the combiner
  // now composes text+markdown+code into one interactive card.
  it("composes text + markdown + code into a single interactive card", async () => {
    const body = await segmentsToLarkBodyAsync(
      [
        { type: "text", text: "Summary below" },
        { type: "markdown", md: "**bold** point" },
        { type: "code", language: "ts", code: "const x = 1" },
      ],
      { adapterId: "adp_lk" }
    )
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    const contents = parsed.body.elements.map((e: { content?: string }) => e.content ?? "")
    expect(contents.some((c: string) => c.includes("Summary below"))).toBe(true)
    expect(contents.some((c: string) => c.includes("**bold** point"))).toBe(true)
    expect(contents.some((c: string) => c.includes("```ts\nconst x = 1\n```"))).toBe(true)
    // No placeholder degradation anywhere.
    expect(contents.some((c: string) => c.includes("[markdown]") || c.includes("[code]"))).toBe(
      false
    )
  })

  it("renders mention segments with the lark_md at-syntax inside combined cards", async () => {
    const body = await segmentsToLarkBodyAsync(
      [
        { type: "markdown", md: "please review" },
        { type: "mention", userId: "ou_rev_1" },
      ],
      { adapterId: "adp_lk" }
    )
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    expect(
      parsed.body.elements.some((e: { content?: string }) => e.content === "<at id=ou_rev_1></at>")
    ).toBe(true)
  })

  it("keeps single markdown segments on the plain segmentToLarkBody path", async () => {
    const body = await segmentsToLarkBodyAsync([{ type: "markdown", md: "**alone**" }], {
      adapterId: "adp_lk",
    })
    // Same interactive rendering, produced by the sync path (no combiner).
    expect(body.msg_type).toBe("interactive")
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

  // Card 2.0 delivers callbacks under `card.action.trigger` with the
  // message/chat ids nested in `event.context`. Previously only the legacy
  // v1 event name was matched, so 2.0 button clicks were silently dropped.
  it("accepts the Card 2.0 card.action.trigger event with context ids", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: {
        event_id: "evt_v2",
        event_type: "card.action.trigger",
        create_time: "1700000000000",
      },
      event: {
        operator: { open_id: "ou_user2" },
        context: { open_chat_id: "oc_chat_v2", open_message_id: "om_msg_v2" },
        action: {
          tag: "button",
          value: { actionId: "a2ui:sfc_2:b9:go", surfaceId: "sfc_2", componentId: "b9" },
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("button")
    expect(cb!.triggerId).toBe("a2ui:sfc_2:b9:go")
    expect(cb!.conversationKey).toBe("lark:adp_lk:oc_chat_v2")
    expect(cb!.originatingMessageId).toBe("om_msg_v2")
  })

  it("lifts a Card 2.0 form_value submit to actionType=submit with the form payload", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: { event_id: "evt_form", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_user2" },
        context: { open_chat_id: "oc_chat_v2" },
        action: {
          tag: "button",
          value: { actionId: "a2ui:sfc_2:submit:ok", surfaceId: "sfc_2", componentId: "submit" },
          form_value: { name: "Alice", dept: "eng" },
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("submit")
    expect(cb!.payload).toEqual({ name: "Alice", dept: "eng" })
  })

  it("lifts a Card 2.0 checked boolean to actionType=checkbox", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: { event_id: "evt_chk_v2", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_user2" },
        context: { open_chat_id: "oc_chat_v2" },
        action: {
          tag: "checker",
          value: { actionId: "a2ui:sfc_2:chk:agree", surfaceId: "sfc_2", componentId: "chk" },
          checked: true,
        },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.actionType).toBe("checkbox")
    expect(cb!.value).toBe("true")
  })
})

describe("buildLarkA2UICard — overlay surfaces (Dialog / Drawer / Sheet)", () => {
  it("renders a Dialog as a divider + bold title section with children inline", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Task", children: ["d1"] },
        d1: { id: "d1", component: "Dialog", title: "Fill the form", body: ["f1", "b1"] },
        f1: { id: "f1", component: "TextField", label: "Name", action: "set_name" },
        b1: { id: "b1", component: "Button", text: "Submit", action: "submit" },
      },
      dataModel: {},
      rootId: "root",
    }
    const body = await buildLarkA2UICard(baseInput(surface))
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    const tags = parsed.body.elements.map((e: { tag: string }) => e.tag)
    // Divider + bold title precede the dialog's children.
    expect(tags).toContain("hr")
    const titleEl = parsed.body.elements.find(
      (e: { tag: string; content?: string }) =>
        e.tag === "markdown" && e.content?.includes("Fill the form")
    )
    expect(titleEl).toBeDefined()
    expect(tags).toContain("input")
    expect(tags).toContain("button")
    const binding = await resolveCallbackBinding("adp_lk", "a2ui:sfc_1:b1:submit")
    expect(binding?.componentId).toBe("b1")
  })
})

describe("segmentsToLarkBodyAsync — resolved media in combined cards", () => {
  it("renders an image segment with a resolved image_key as a real img element", async () => {
    const surface: A2UISegmentContent = {
      components: { root: { id: "root", component: "Text", text: "chart below" } },
      dataModel: {},
      rootId: "root",
    }
    const body = await segmentsToLarkBodyAsync(
      [
        {
          type: "a2ui",
          surfaceId: "sfc_img",
          content: surface,
          plainTextMirror: "chart below",
        },
        { type: "image", url: "img_v3_abc123", alt: "weekly chart" },
      ],
      { adapterId: "adp_lk", conversationKey: "lark:adp_lk:oc_chat" }
    )
    const parsed = JSON.parse(body.content)
    const img = parsed.body.elements.find((e: { tag: string }) => e.tag === "img") as
      { img_key: string; alt: { content: string } } | undefined
    expect(img).toBeDefined()
    expect(img!.img_key).toBe("img_v3_abc123")
    expect(img!.alt.content).toBe("weekly chart")
  })

  it("keeps the textual placeholder for unresolved remote image URLs", async () => {
    const surface: A2UISegmentContent = {
      components: { root: { id: "root", component: "Text", text: "x" } },
      dataModel: {},
      rootId: "root",
    }
    const body = await segmentsToLarkBodyAsync(
      [
        { type: "a2ui", surfaceId: "sfc_img2", content: surface, plainTextMirror: "x" },
        { type: "image", url: "https://example.com/pic.png", alt: "remote" },
      ],
      { adapterId: "adp_lk" }
    )
    const parsed = JSON.parse(body.content)
    expect(parsed.body.elements.some((e: { tag: string }) => e.tag === "img")).toBe(false)
  })
})

describe("parseLarkInteractiveCallback identityScope (plan 2026-07-24 Phase 2)", () => {
  it("carries tenant_key/app_id from the verified envelope", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: {
        event_id: "evt_scope",
        event_type: "card.action.trigger",
        app_id: "cli_app",
      },
      event: {
        operator: { open_id: "ou_clicker" },
        tenant_key: "tk_body",
        context: { open_chat_id: "oc_chat", open_message_id: "om_msg" },
        action: { tag: "button", value: { actionId: "a2ui:s:c:go", surfaceId: "s" } },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.identityScope).toEqual({ tenantKey: "tk_body", appId: "cli_app" })
  })

  it("leaves identityScope undefined when the envelope has no tenancy signal", () => {
    const envelope: LarkEventEnvelope = {
      schema: "2.0",
      header: { event_id: "evt_ns", event_type: "card.action.trigger" },
      event: {
        operator: { open_id: "ou_clicker" },
        context: { open_chat_id: "oc_chat" },
        action: { tag: "button", value: { actionId: "a2ui:s:c:go", surfaceId: "s" } },
      } as unknown as LarkEventEnvelope["event"],
    }
    const cb = parseLarkInteractiveCallback("adp_lk", "BOT", envelope)
    expect(cb!.identityScope).toBeUndefined()
  })
})

it("serializes help as Card 2.0 while preserving callback bindings", async () => {
  const content = {
    rootId: "root",
    dataModel: {},
    components: {
      root: { component: "Card", title: "命令帮助", children: ["text", "button"] },
      text: { component: "Text", text: "请选择命令" },
      button: {
        component: "Button",
        text: "查看状态",
        action: "status",
        bindingKind: "help_quick_command",
        bindingPayload: { action: { type: "text", text: "/status" } },
      },
    },
  }
  const body = await segmentsToLarkBodyAsync(
    [{ type: "a2ui", surfaceId: "help:chat:unique", content, plainTextMirror: "help" }],
    { adapterId: "adapter", conversationKey: "lark:adapter:chat" }
  )
  const card = JSON.parse(body.content)
  expect(card.schema).toBe("2.0")
  expect(card.header.title.content).toBe("命令帮助")
  expect(card.body.elements[0]).toMatchObject({ tag: "markdown", content: "请选择命令" })
  const button = card.body.elements[1]
  expect(button.tag).toBe("button")
  expect(button.value).toBeUndefined()
  expect(button.behaviors[0]).toMatchObject({
    type: "callback",
    value: { surfaceId: "help:chat:unique", componentId: "button" },
  })
})

it("uses the shared frame and keeps the empty task-list description", async () => {
  const body = await segmentsToLarkBodyAsync(
    [
      {
        type: "a2ui",
        surfaceId: "schedule-list-test",
        plainTextMirror: "No tasks",
        content: {
          rootId: "root",
          dataModel: {},
          components: {
            root: {
              component: "Card",
              title: "Scheduled tasks",
              description: "No tasks",
              children: [],
            },
          },
        },
      },
    ],
    { adapterId: "adapter" }
  )
  const card = JSON.parse(body.content)
  expect(card.schema).toBe("2.0")
  expect(card.body.elements).toEqual([{ tag: "markdown", content: "No tasks" }])
})

describe("Card 2.0 native controls", () => {
  it("preserves multiline, checked, disabled and multiple bound values", async () => {
    const body = await buildLarkA2UICard(
      baseInput({
        rootId: "root",
        dataModel: { agreed: true, choices: ["a", "b"] },
        components: {
          root: {
            component: "FormGroup",
            children: ["body", "check", "select", "submit", "reset"],
          },
          body: {
            component: "TextArea",
            label: "Details",
            rows: 4,
            required: true,
            value: "line1\nline2",
          },
          check: {
            component: "Checkbox",
            label: "Agree",
            checked: { path: "/agreed" },
            disabled: true,
          },
          select: {
            component: "Select",
            multiple: true,
            value: { path: "/choices" },
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
          submit: { component: "Button", text: "Submit", action: "submit" },
          reset: { component: "Button", text: "Reset", action: "reset" },
        },
      })
    )
    const card = JSON.parse(body.content)
    expect(card.schema).toBe("2.0")
    expect(card.elements).toBeUndefined()
    const form = card.body.elements[0]
    expect(form.tag).toBe("form")
    expect(form.elements[0]).toMatchObject({
      tag: "input",
      input_type: "multiline_text",
      rows: 4,
      required: true,
      default_value: "line1\nline2",
    })
    expect(form.elements[1]).toMatchObject({ tag: "checker", checked: true, disabled: true })
    expect(form.elements[2]).toMatchObject({
      tag: "multi_select_static",
      selected_values: ["a", "b"],
    })
    expect(form.elements[3]).toMatchObject({ tag: "button", form_action_type: "submit" })
    expect(form.elements[4]).toMatchObject({ tag: "button", form_action_type: "reset" })
    expect(await resolveCallbackBinding("adp_lk", "a2ui:sfc_1:submit:submit")).toMatchObject({
      componentId: "submit",
    })
  })

  it("keeps nested layouts, data tables and unknown content visible", async () => {
    const body = await buildLarkA2UICard(
      baseInput({
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Column", children: ["row", "panel", "table", "chart", "unknown"] },
          row: { component: "Row", children: ["left", "right"] },
          left: { component: "Text", text: "Left" },
          right: { component: "Text", text: "Right" },
          panel: { component: "Collapsible", title: "Details", open: false, children: ["detail"] },
          detail: { component: "Text", text: "Still present" },
          table: {
            component: "Table",
            columns: [{ key: "count", header: "Count", type: "number" }],
            data: [{ count: 3 }],
            pageSize: 99,
          },
          chart: { component: "Chart", chartType: "bar", data: [{ name: "A", value: 4 }] },
          unknown: { component: "UnsupportedWidget", label: "Retained", value: "value" },
        },
      })
    )
    const card = JSON.parse(body.content)
    expect(card.body.elements[0]).toMatchObject({
      tag: "column_set",
      columns: [{ tag: "column" }, { tag: "column" }],
    })
    expect(card.body.elements[1]).toMatchObject({
      tag: "collapsible_panel",
      expanded: false,
      elements: [{ tag: "markdown", content: "Still present" }],
    })
    expect(card.body.elements[2]).toMatchObject({
      tag: "table",
      page_size: 10,
      rows: [{ count: 3 }],
    })
    expect(card.body.elements[3]).toMatchObject({
      tag: "chart",
      chart_spec: { type: "bar", data: { values: [{ name: "A", value: 4 }] } },
    })
    expect(body.content).toContain("Retained")
  })
})

it("keeps independent form names unique and normalizes submitted names to component IDs", async () => {
  const surface: A2UISegmentContent = {
    rootId: "form",
    dataModel: {},
    components: {
      form: { component: "FormGroup", children: ["field", "submit"] },
      field: { component: "TextField", label: "Name", required: true },
      submit: { component: "Button", text: "Save", action: "save", formAction: "submit" },
    },
  }
  const body = await segmentsToLarkBodyAsync(
    ["one", "two"].map((surfaceId) => ({
      type: "a2ui" as const,
      surfaceId,
      content: surface,
      plainTextMirror: "Form",
    })),
    { adapterId: "adp_lk" }
  )
  const forms = JSON.parse(body.content).body.elements
  expect(forms[0].name).not.toBe(forms[1].name)
  const form = forms[1]
  const callback = parseLarkInteractiveCallback("adp_lk", "BOT", {
    schema: "2.0",
    header: { event_id: "form_2", event_type: "card.action.trigger" },
    event: {
      operator: { open_id: "ou_user" },
      action: {
        tag: "button",
        value: form.elements[1].behaviors[0].value,
        form_value: { [form.elements[0].name]: "Alice" },
      },
    },
  } as LarkEventEnvelope)
  expect(callback).toMatchObject({
    actionType: "submit",
    surfaceId: "two",
    componentId: "submit",
    payload: { field: "Alice" },
  })
})

it("wraps standalone multiple selectors in a valid form and preserves array values", async () => {
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "pick",
      dataModel: {},
      components: {
        pick: {
          component: "Select",
          multiple: true,
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      },
    })
  )
  const form = JSON.parse(body.content).body.elements[0]
  expect(form.tag).toBe("form")
  expect(form.elements[0].required).toBe(false)
  const cb = parseLarkInteractiveCallback("adp_lk", "BOT", {
    schema: "2.0",
    header: { event_id: "multi", event_type: "card.action.trigger" },
    event: {
      operator: { open_id: "ou_user" },
      action: {
        tag: "button",
        value: form.elements[1].behaviors[0].value,
        form_value: { [form.elements[0].name]: ["a", "b"] },
      },
    },
  } as LarkEventEnvelope)
  expect(cb).toMatchObject({
    actionType: "select",
    componentId: "pick",
    value: '["a","b"]',
    payload: { values: ["a", "b"] },
  })
})

it("avoids illegal form/table nesting without losing content", async () => {
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "panel",
      dataModel: {},
      components: {
        panel: { component: "Collapsible", title: "Panel", children: ["form"] },
        form: { component: "FormGroup", children: ["nested", "table"] },
        nested: { component: "FormGroup", children: ["field"] },
        field: { component: "TextField", value: "kept", required: true },
        table: {
          component: "Table",
          columns: [{ key: "k", header: "K" }],
          data: [{ k: "entire row" }],
        },
      },
    })
  )
  const card = JSON.parse(body.content)
  expect(body.content.match(/"tag":"form"/g)).toHaveLength(1)
  expect(body.content).not.toContain('"tag":"collapsible_panel"')
  expect(body.content).not.toContain('"tag":"table"')
  expect(body.content).toContain("entire row")
  const form = card.body.elements.find((e: { tag: string }) => e.tag === "form")
  expect(form.elements[0]).toMatchObject({ tag: "input", required: true })
  expect(form.elements.at(-1)).toMatchObject({ tag: "button", form_action_type: "submit" })
})

it("preserves multiple children within a Row column", async () => {
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "row",
      dataModel: {},
      components: {
        row: { component: "Row", children: ["column", "other"] },
        column: { component: "Column", children: ["a", "b"] },
        a: { component: "Text", text: "A" },
        b: { component: "Text", text: "B" },
        other: { component: "Text", text: "Other" },
      },
    })
  )
  const columns = JSON.parse(body.content).body.elements[0].columns
  expect(columns).toHaveLength(2)
  expect(columns[0].elements.map((e: { content: string }) => e.content)).toEqual(["A", "B"])
})

it("keeps result card content and style when appended to an A2UI surface", async () => {
  const body = await segmentsToLarkBodyAsync(
    [
      {
        type: "a2ui",
        surfaceId: "controls",
        plainTextMirror: "Pick",
        content: {
          rootId: "go",
          dataModel: {},
          components: { go: { component: "Button", text: "Go", action: "go" } },
        },
      },
      {
        type: "card",
        card: {
          kind: "lark",
          payload: {
            schema: "2.0",
            config: {
              width_mode: "fill",
              style: { text_size: { normal: { default: "normal", pc: "heading" } } },
            },
            header: { title: { tag: "plain_text", content: "Answer" } },
            body: { padding: "8px", elements: [{ tag: "markdown", content: "Complete answer" }] },
          },
        },
      },
    ],
    { adapterId: "adp_lk" }
  )
  const card = JSON.parse(body.content)
  expect(card.config.width_mode).toBe("fill")
  expect(card.config.style.text_size.normal.pc).toBe("heading")
  expect(card.header.title.content).toBe("Answer")
  expect(card.body.padding).toBe("8px")
  expect(card.body.elements).toMatchObject([
    { tag: "button" },
    { tag: "markdown", content: "Complete answer" },
  ])
  expect(body.content).not.toContain("[card]")
})

it("does not turn ordinary form buttons or links into submit actions", async () => {
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "form",
      dataModel: {},
      components: {
        form: { component: "FormGroup", children: ["field", "cancel", "link"] },
        field: { component: "TextField", required: true },
        cancel: { component: "Button", text: "Cancel", action: "cancel" },
        link: {
          component: "Button",
          text: "Help",
          action: "help",
          href: "https://example.com/help",
        },
      },
    })
  )
  const elements = JSON.parse(body.content).body.elements[0].elements
  expect(elements[1].form_action_type).toBeUndefined()
  expect(elements[2].form_action_type).toBeUndefined()
  expect(elements[2].behaviors[0]).toEqual({
    type: "open_url",
    default_url: "https://example.com/help",
  })
  expect(elements[3]).toMatchObject({ tag: "button", form_action_type: "submit" })
})

it("preserves every value when a generated card exceeds the element limit", async () => {
  const components = Object.fromEntries(
    Array.from({ length: 205 }, (_, i) => [`text_${i}`, { component: "Text", text: `Retain ${i}` }])
  )
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "root",
      dataModel: {},
      components: {
        root: { component: "Column", children: Object.keys(components) },
        ...components,
      },
    })
  )
  const elements = JSON.parse(body.content).body.elements
  expect(elements).toHaveLength(1)
  expect(elements[0].content).toContain("controls are shown as text")
  for (let i = 0; i < 205; i++) expect(elements[0].content).toContain(`Retain ${i}`)
})

it("deduplicates composed card IDs and preserves independent named styles", async () => {
  const payloads = ["one", "two"].map((name) => ({
    schema: "2.0",
    config: { style: { text_size: { [name]: { default: "normal" } } } },
    body: { elements: [{ tag: "markdown", element_id: "answer", content: name }] },
  }))
  const body = await segmentsToLarkBodyAsync(
    payloads.map((payload) => ({ type: "card" as const, card: { kind: "lark", payload } })),
    { adapterId: "adp_lk" }
  )
  const card = JSON.parse(body.content)
  expect(card.config.style.text_size).toHaveProperty("one")
  expect(card.config.style.text_size).toHaveProperty("two")
  const ids = card.body.elements.map((e: { element_id: string }) => e.element_id)
  expect(new Set(ids).size).toBe(2)
  expect(payloads[1].body.elements[0].element_id).toBe("answer")
})

it("keeps pie charts on the first metric and normalizes table page sizes", async () => {
  const body = await buildLarkA2UICard(
    baseInput({
      rootId: "root",
      dataModel: {},
      components: {
        root: { component: "Column", children: ["chart", "table"] },
        chart: {
          component: "Chart",
          chartType: "pie",
          yKeys: ["sales", "cost"],
          data: [{ name: "A", sales: 10, cost: 5 }],
        },
        table: {
          component: "Table",
          columns: [{ key: "name", header: "Name" }],
          data: [{ name: "A" }],
          pageSize: 2.5,
        },
      },
    })
  )
  const elements = JSON.parse(body.content).body.elements
  expect(elements[0].chart_spec).toMatchObject({
    type: "pie",
    valueField: "sales",
    data: { values: [{ name: "A", sales: 10, cost: 5 }] },
  })
  expect(elements[1].page_size).toBe(2)
})
