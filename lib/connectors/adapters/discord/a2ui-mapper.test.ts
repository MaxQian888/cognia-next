/**
 * Tests for the Discord A2UI mapper — embeds + components projection
 * with callback-binding persistence against the v38 schema.
 */

import "fake-indexeddb/auto"
import { buildDiscordA2UIPayload } from "./a2ui-mapper"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const baseInput = (surface: A2UISegmentContent) => ({
  adapterId: "adp_dc",
  surfaceId: "sfc_1",
  surface,
  conversationKey: "discord:adp_dc:ch_xyz",
})

describe("buildDiscordA2UIPayload", () => {
  it("renders Card + Text into a rich embed", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Daily", children: ["t1"] },
        t1: { id: "t1", component: "Text", text: "Hello" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    expect(payload.embeds).toHaveLength(1)
    expect(payload.embeds![0]).toMatchObject({ title: "Daily", description: "Hello" })
  })

  it("renders Alert into a coloured embed with ⚠️ prefix", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Alert", title: "Watch out", text: "Failure" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    expect(payload.embeds).toHaveLength(1)
    expect(payload.embeds![0].title).toContain("⚠️")
    expect(payload.embeds![0].description).toBe("Failure")
  })

  it("groups Buttons into ActionRow with callback bindings", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["b1", "b2"] },
        b1: { id: "b1", component: "Button", text: "Yes", action: "yes" },
        b2: { id: "b2", component: "Button", text: "No", action: "no", variant: "destructive" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    expect(payload.components).toHaveLength(1)
    const row = payload.components![0] as {
      type: number
      components: Array<{ style: number; label: string; custom_id: string }>
    }
    expect(row.type).toBe(1)
    expect(row.components).toHaveLength(2)
    expect(row.components[0].label).toBe("Yes")
    expect(row.components[1].label).toBe("No")
    expect(row.components[1].style).toBe(4) // danger
    const binding = await resolveCallbackBinding("adp_dc", "a2ui:sfc_1:b1:yes")
    expect(binding?.surfaceId).toBe("sfc_1")
    expect(binding?.conversationKey).toBe("discord:adp_dc:ch_xyz")
  })

  it("link buttons set url + skip callback bindings persistence (but record still kept for parity)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: {
          id: "root",
          component: "Button",
          text: "Docs",
          action: "open",
          href: "https://x/y",
        },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    const btn = (payload.components![0] as { components: Array<Record<string, unknown>> })
      .components[0]
    expect(btn.style).toBe(5)
    expect(btn.url).toBe("https://x/y")
    expect(btn.custom_id).toBeUndefined()
  })

  it("renders Select as a dedicated ActionRow (component_type=3)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["sel", "btn"] },
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
        btn: { id: "btn", component: "Button", text: "OK", action: "ok" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    expect(payload.components).toHaveLength(2)
    const selectRow = payload.components![0] as { components: Array<Record<string, unknown>> }
    expect(selectRow.components[0].type).toBe(3)
    expect(
      (selectRow.components[0].options as Array<{ label: string }>).map((o) => o.label)
    ).toEqual(["Alpha", "Beta"])
    const buttonRow = payload.components![1] as { components: Array<Record<string, unknown>> }
    expect(buttonRow.components[0].type).toBe(2)
  })

  it("falls back to plainTextMirror entry-point when no native components match", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Chart", chartType: "bar" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    expect(payload.content).toBeUndefined()
    expect(payload.embeds).toBeUndefined()
    expect(payload.components).toBeUndefined()
  })
})
