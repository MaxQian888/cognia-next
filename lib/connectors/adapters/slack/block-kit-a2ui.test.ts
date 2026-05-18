/**
 * Tests for buildSlackA2UIBlocks — Slack Block Kit projection of
 * an A2UI surface (G3.3).
 */

import "fake-indexeddb/auto"
import { buildSlackA2UIBlocks } from "./block-kit"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const baseInput = (surface: A2UISegmentContent) => ({
  adapterId: "adp_sl",
  surfaceId: "sfc_1",
  surface,
  conversationKey: "slack:adp_sl:C_xyz",
})

describe("buildSlackA2UIBlocks", () => {
  it("Card title → header block", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Daily" },
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Daily" },
    })
  })

  it("Buttons → single actions block; Select → input block", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["b1", "b2", "sel"] },
        b1: { id: "b1", component: "Button", text: "Yes", action: "yes", variant: "primary" },
        b2: { id: "b2", component: "Button", text: "No", action: "no", variant: "destructive" },
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
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    expect(blocks.map((b) => b.type)).toEqual(["actions", "input"])
    const actions = blocks[0] as { elements: Array<Record<string, unknown>> }
    expect(actions.elements).toHaveLength(2)
    expect(actions.elements[0]).toMatchObject({
      type: "button",
      style: "primary",
      action_id: "a2ui:sfc_1:b1:yes",
    })
    expect(actions.elements[1]).toMatchObject({
      style: "danger",
      action_id: "a2ui:sfc_1:b2:no",
    })
    const input = blocks[1] as unknown as {
      element: { type: string; options: Array<{ value: string }> }
    }
    expect(input.element.type).toBe("static_select")
    expect(input.element.options.map((o) => o.value)).toEqual(["a", "b"])

    // Bindings round-trip via connectorCallbackBindings.
    const b1Binding = await resolveCallbackBinding("adp_sl", "a2ui:sfc_1:b1:yes")
    expect(b1Binding?.componentId).toBe("b1")
    expect(b1Binding?.conversationKey).toBe("slack:adp_sl:C_xyz")
  })

  it("DatePicker / TimePicker → input blocks with picker elements", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["d", "t"] },
        d: { id: "d", component: "DatePicker", value: "", label: "Start" },
        t: { id: "t", component: "TimePicker", value: "", label: "From" },
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    expect(blocks.map((b) => b.type)).toEqual(["input", "input"])
    expect((blocks[0] as unknown as { element: { type: string } }).element.type).toBe("datepicker")
    expect((blocks[1] as unknown as { element: { type: string } }).element.type).toBe("timepicker")
  })

  it("TextField / TextArea → plain_text_input (multiline flag for TextArea)", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["i1", "i2"] },
        i1: { id: "i1", component: "TextField", value: "", label: "Name" },
        i2: { id: "i2", component: "TextArea", value: "", label: "Notes" },
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    const e1 = (blocks[0] as unknown as { element: { type: string; multiline: boolean } }).element
    const e2 = (blocks[1] as unknown as { element: { type: string; multiline: boolean } }).element
    expect(e1.type).toBe("plain_text_input")
    expect(e1.multiline).toBe(false)
    expect(e2.multiline).toBe(true)
  })

  it("Alert → section with :warning: prefix", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Alert", title: "Heads up", text: "Backup failed" },
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    const section = blocks[0] as { text: { text: string } }
    expect(section.text.text).toContain(":warning:")
    expect(section.text.text).toContain("Heads up")
    expect(section.text.text).toContain("Backup failed")
  })

  it("Divider → divider block", async () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Divider" },
      },
      dataModel: {},
      rootId: "root",
    }
    const blocks = await buildSlackA2UIBlocks(baseInput(surface))
    expect(blocks[0]).toEqual({ type: "divider" })
  })
})
