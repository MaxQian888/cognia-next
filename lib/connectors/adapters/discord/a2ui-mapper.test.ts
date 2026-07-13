/** @jest-environment jsdom */
/**
 * Tests for the Discord A2UI mapper — embeds + components projection
 * with callback-binding persistence against the v38 schema.
 */

import "fake-indexeddb/auto"
import { buildDiscordA2UIPayload, buildDiscordModalData } from "./a2ui-mapper"
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

  // ── modal two-hop (TextField / TextArea / Dialog) ──────────────────────────

  it("projects a Dialog with text inputs into a modal-open trigger button", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Dialog", title: "Feedback", body: ["name", "notes"] },
        name: {
          id: "name",
          component: "TextField",
          label: "Your name",
          required: true,
          placeholder: "Jane",
        },
        notes: { id: "notes", component: "TextArea", label: "Notes" },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))

    // A single trigger button in one action row — inputs are NOT rendered inline.
    expect(payload.components).toHaveLength(1)
    const row = payload.components![0] as {
      components: Array<{ type: number; custom_id: string; label: string }>
    }
    expect(row.components).toHaveLength(1)
    const button = row.components[0]
    expect(button.type).toBe(2)
    expect(button.label).toBe("Feedback")
    const actionId = "a2ui:sfc_1:root:submit"
    expect(button.custom_id).toBe(actionId)

    const binding = await resolveCallbackBinding("adp_dc", actionId)
    expect(binding?.kind).toBe("modal_open")
    const modalPayload = binding?.payload as {
      title: string
      inputs: Array<{ customId: string; style: number; required?: boolean }>
    }
    expect(modalPayload.title).toBe("Feedback")
    expect(modalPayload.inputs.map((i) => i.customId)).toEqual(["name", "notes"])
    expect(modalPayload.inputs[0]).toMatchObject({ style: 1, required: true })
    expect(modalPayload.inputs[1]).toMatchObject({ style: 2 })
  })

  it("caps modal inputs at Discord's 5-field limit", async () => {
    const ids = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"]
    const components: A2UISegmentContent["components"] = {
      root: { id: "root", component: "Dialog", title: "Big", body: ids },
    }
    for (const id of ids) components[id] = { id, component: "TextField", label: id }
    const surface: A2UISegmentContent = { components, dataModel: {}, rootId: "root" }

    await buildDiscordA2UIPayload(baseInput(surface))
    const binding = await resolveCallbackBinding("adp_dc", "a2ui:sfc_1:root:submit")
    const modalPayload = binding?.payload as { inputs: unknown[] }
    expect(modalPayload.inputs).toHaveLength(5)
  })

  it("buildDiscordModalData wraps each input in its own ActionRow (type 9 data)", () => {
    const data = buildDiscordModalData("cid", {
      title: "T",
      inputs: [
        { customId: "a", label: "A", style: 1, required: true, placeholder: "ph" },
        { customId: "b", label: "B", style: 2 },
      ],
    })
    expect(data.custom_id).toBe("cid")
    expect(data.title).toBe("T")
    const rows = data.components as Array<{
      type: number
      components: Array<Record<string, unknown>>
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0].type).toBe(1)
    expect(rows[0].components[0]).toMatchObject({
      type: 4,
      custom_id: "a",
      label: "A",
      style: 1,
      required: true,
      placeholder: "ph",
    })
    expect(rows[1].components[0]).toMatchObject({ type: 4, custom_id: "b", style: 2, required: false })
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

  // ── custom_id truncation ⇄ binding round-trip (>100 chars) ────────────────

  it("binds a truncated Button custom_id so the wire id round-trips through resolveCallbackBinding", async () => {
    const longAction = "act_" + "x".repeat(120)
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Button", text: "Go", action: longAction },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    const btn = (payload.components![0] as { components: Array<Record<string, unknown>> })
      .components[0]
    const wireId = btn.custom_id as string
    // Discord caps custom_id at 100 chars — the wire id must be truncated…
    expect(wireId.length).toBeLessThanOrEqual(100)
    expect(wireId).not.toBe(`a2ui:sfc_1:root:${longAction}`)
    // …and the binding row must be keyed by the WIRE id (exact-match lookup).
    const binding = await resolveCallbackBinding("adp_dc", wireId)
    expect(binding?.surfaceId).toBe("sfc_1")
    expect(binding?.componentId).toBe("root")
  })

  it("binds a truncated Select custom_id the same way", async () => {
    const longAction = "pick_" + "y".repeat(120)
    const surface: A2UISegmentContent = {
      components: {
        root: {
          id: "root",
          component: "Select",
          action: longAction,
          options: [{ value: "a", label: "Alpha" }],
        },
      },
      dataModel: {},
      rootId: "root",
    }
    const payload = await buildDiscordA2UIPayload(baseInput(surface))
    const select = (payload.components![0] as { components: Array<Record<string, unknown>> })
      .components[0]
    const wireId = select.custom_id as string
    expect(wireId.length).toBeLessThanOrEqual(100)
    const binding = await resolveCallbackBinding("adp_dc", wireId)
    expect(binding?.surfaceId).toBe("sfc_1")
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
