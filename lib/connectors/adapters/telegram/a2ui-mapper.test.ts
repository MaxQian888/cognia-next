/**
 * Tests for the Telegram A2UI mapper.
 *
 * Uses fake-indexeddb so the callback-binding persistence path lights up
 * end-to-end against the v38 schema.
 */

import "fake-indexeddb/auto"
import { buildTelegramA2UICalls } from "./a2ui-mapper"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const baseInput = (surface: A2UISegmentContent) => ({
  adapterId: "adp_tg",
  chatId: 12345,
  surfaceId: "sfc_1",
  surface,
  conversationKey: "telegram:adp_tg:12345",
  routing: {},
})

describe("buildTelegramA2UICalls — text + media", () => {
  it("emits a single sendMessage with MarkdownV2 body when only text is present", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t1", "t2"] },
        t1: { id: "t1", component: "Text", text: "Hello", variant: "heading1" },
        t2: { id: "t2", component: "Text", text: "World!" },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("sendMessage")
    expect(calls[0].payload).toMatchObject({
      chat_id: 12345,
      parse_mode: "MarkdownV2",
      text: expect.stringContaining("*Hello*"),
    })
    expect(calls[0].payload.text).toContain("World")
  })

  it("emits sendPhoto for each Image component plus a sendMessage body", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["i1", "t1"] },
        i1: { id: "i1", component: "Image", src: "https://x/y.png", alt: "Chart" },
        t1: { id: "t1", component: "Text", text: "Caption" },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"])
    expect(calls[0].payload).toMatchObject({ photo: "https://x/y.png" })
    expect(calls[0].payload.caption).toContain("Chart")
  })

  it("renders Link components as MarkdownV2 inline links", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Link", text: "Open", href: "https://example.com" },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    expect(calls[0].payload.text).toBe("[Open](https://example.com)")
  })

  it("renders Alert with ⚠️ + bold title + body", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Alert", title: "Heads up", text: "Backup failed" },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    expect(calls[0].payload.text).toContain("⚠️")
    expect(calls[0].payload.text).toContain("*Heads up*")
  })
})

describe("buildTelegramA2UICalls — buttons + callback bindings", () => {
  it("emits an InlineKeyboardMarkup with rows + persists bindings", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t1", "btn1", "btn2"] },
        t1: { id: "t1", component: "Text", text: "Choose:" },
        btn1: { id: "btn1", component: "Button", text: "Yes", action: "confirm" },
        btn2: { id: "btn2", component: "Button", text: "No", action: "deny" },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    expect(calls).toHaveLength(1)
    const reply = calls[0].payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
    }
    expect(reply.inline_keyboard).toBeDefined()
    // Both buttons share the same row (sibling Buttons at depth 2).
    expect(reply.inline_keyboard).toHaveLength(1)
    expect(reply.inline_keyboard[0].map((b) => b.text)).toEqual(["Yes", "No"])

    // Bindings were persisted so the callback channel can recover
    // surfaceId/componentId from the wire id.
    const yesBinding = await resolveCallbackBinding("adp_tg", "a2ui:sfc_1:btn1:confirm")
    expect(yesBinding).toBeDefined()
    expect(yesBinding?.surfaceId).toBe("sfc_1")
    expect(yesBinding?.componentId).toBe("btn1")
    expect(yesBinding?.conversationKey).toBe("telegram:adp_tg:12345")
  })

  it("renders Button.href as a url-type button (no callback_data)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: {
          id: "root",
          component: "Button",
          text: "Docs",
          action: "noop",
          href: "https://example.com/docs",
        },
      },
      dataModel: {},
      rootId: "root",
    }
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    const btn = (
      calls[0].payload.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
    ).inline_keyboard[0][0]
    expect(btn.url).toBe("https://example.com/docs")
    expect(btn.callback_data).toBeUndefined()
  })

  it("truncates long action ids to the 64-byte wire cap (binding row keeps the full id)", async () => {
    const longComponentId = "btn_" + "x".repeat(80)
    const longAction = "a_" + "y".repeat(80)
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Button", text: "Long", action: longAction },
      },
      dataModel: {},
      rootId: "root",
    }
    // Replace the placeholder root with a Button keyed by the long id so
    // the walker's `components[rootId]` lookup actually resolves.
    delete (surface.components as Record<string, unknown>).root
    ;(surface.components as Record<string, unknown>)[longComponentId] = {
      id: longComponentId,
      component: "Button",
      text: "Long",
      action: longAction,
    }
    surface.rootId = longComponentId
    const calls = await buildTelegramA2UICalls(baseInput(surface))
    const btn = (
      calls[0].payload.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
    ).inline_keyboard[0][0]
    const wireId = btn.callback_data as string
    expect(new TextEncoder().encode(wireId).length).toBeLessThanOrEqual(64)
    expect(wireId.startsWith("a2ui:#")).toBe(true)
    // The binding row uses the FULL id, not the hash.
    const fullId = `a2ui:sfc_1:${longComponentId}:${longAction}`
    const binding = await resolveCallbackBinding("adp_tg", fullId)
    expect(binding?.componentId).toBe(longComponentId)
  })
})
