/**
 * Workflow Copilot template registry — schema + materialization tests.
 *
 * Every shipped template must:
 *   • be registered in the `listCopilotTemplates()` order
 *   • build a graph whose every node passes `validateAllNodes` even when
 *     all slots are at their declared defaults (zero-config sanity)
 *   • build a graph free of duplicate node / edge ids and free of edges
 *     that dangle (source / target referencing a node id that does not
 *     exist in the same build output)
 *
 * The registry-level helper `materializeCopilotTemplate` must:
 *   • reject unknown ids with `code: "unknown-template"`
 *   • reject missing required slots with `code: "missing-required-slot"`
 *     and the offending key list
 *   • call into the template's `build` with merged slot values (caller
 *     overrides default; default fills in when caller is silent)
 */

import { getCopilotTemplate, listCopilotTemplates, materializeCopilotTemplate } from "./index"
import { validateAllNodes } from "@/lib/workflow/nodes/validate-params"
import type { CopilotSlotValues } from "./types"

function nodesForValidator(workflow: {
  nodes: ReadonlyArray<{ id: string; type: string; data: { params?: Record<string, unknown> } }>
}): Array<{ id: string; data: { kind: string; params?: Record<string, unknown> } }> {
  return workflow.nodes.map((n) => ({ id: n.id, data: { kind: n.type, params: n.data.params } }))
}

describe("listCopilotTemplates", () => {
  it("returns the platform-neutral templates in stable order", () => {
    const ids = listCopilotTemplates().map((t) => t.id)
    expect(ids).toEqual(["cron-report", "webhook-ai-connector"])
  })

  it("each registered template is reachable via getCopilotTemplate", () => {
    for (const t of listCopilotTemplates()) {
      expect(getCopilotTemplate(t.id)?.id).toBe(t.id)
    }
  })
})

describe("every shipped template builds a schema-valid graph", () => {
  for (const template of listCopilotTemplates()) {
    it(`${template.id}: build({}) passes validateAllNodes`, () => {
      const wf = template.build({})
      // 1. validation: every node's params parse against its zod schema.
      const result = validateAllNodes(nodesForValidator(wf))
      const failingIds = Object.entries(result)
        .filter(([, v]) => v.hasErrors)
        .map(([id, v]) => `${id}: ${v.summary.join("; ")}`)
      expect(failingIds).toEqual([])
      // 2. structural: ids are unique and edges only reference existing nodes.
      const nodeIds = new Set(wf.nodes.map((n) => n.id))
      expect(nodeIds.size).toBe(wf.nodes.length) // no dup node ids
      const edgeIds = new Set(wf.edges.map((e) => e.id))
      expect(edgeIds.size).toBe(wf.edges.length) // no dup edge ids
      for (const e of wf.edges) {
        expect(nodeIds.has(e.source)).toBe(true)
        expect(nodeIds.has(e.target)).toBe(true)
      }
      // 3. every AI-stamped node has the provenance marker.
      for (const n of wf.nodes) {
        expect(n.data.authoredBy).toBe("ai")
      }
    })

    it(`${template.id}: every required slot has either defaultValue or is plainly stringy`, () => {
      // Sanity that test fixtures below remain useful — if a required slot
      // grows a more complex shape later, we'd surface it here.
      for (const slot of template.slots) {
        if (slot.required) {
          expect(["string", "number", "select"]).toContain(slot.type)
        }
      }
    })
  }
})

describe("materializeCopilotTemplate", () => {
  it("returns unknown-template for an unregistered id", () => {
    const result = materializeCopilotTemplate("definitely-not-a-template", {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("unknown-template")
    }
  })

  it("returns missing-required-slot listing every empty required slot", () => {
    const template = getCopilotTemplate("cron-report")!
    const requiredKeys = template.slots
      .filter((s) => s.required && s.defaultValue === undefined)
      .map((s) => s.key)
    // Provide nothing — every required slot without a defaultValue should surface.
    const result = materializeCopilotTemplate("cron-report", {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("missing-required-slot")
      expect(new Set(result.missing)).toEqual(new Set(requiredKeys))
    }
  })

  it("treats empty / whitespace strings as missing", () => {
    const result = materializeCopilotTemplate("cron-report", {
      sourceUrl: "   ",
      adapterId: "telegram_main",
      conversationKey: "ops",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toContain("sourceUrl")
    }
  })

  it("substitutes caller-provided slots and falls back to defaultValue when slot is silent", () => {
    const slots: CopilotSlotValues = {
      sourceUrl: "https://example.com/feed",
      adapterId: "lark_main",
      conversationKey: "weekly-delivery",
    }
    const result = materializeCopilotTemplate("cron-report", slots)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const triggerNode = result.workflow.nodes.find((n) => n.id === "n_cron")
      expect(triggerNode?.data.params).toMatchObject({
        cron: "0 9 * * 1-5",
      })
      const sendNode = result.workflow.nodes.find((n) => n.id === "n_send")
      expect(sendNode?.data.params).toMatchObject({
        adapterId: "lark_main",
        conversationKey: "weekly-delivery",
      })
    }
  })

  it("honours caller overrides over default", () => {
    const result = materializeCopilotTemplate("cron-report", {
      cronExpression: "0 9 * * *",
      sourceUrl: "https://example.com/operations",
      adapterId: "telegram_main",
      conversationKey: "operations",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const triggerNode = result.workflow.nodes.find((n) => n.id === "n_cron")
      expect(triggerNode?.data.params).toMatchObject({ cron: "0 9 * * *" })
      const fetchNode = result.workflow.nodes.find((n) => n.id === "n_fetch")
      expect(fetchNode?.data.params).toMatchObject({
        url: "https://example.com/operations",
      })
    }
  })
})
