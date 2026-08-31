import * as LucideIcons from "lucide-react"
import { Workflow as WorkflowIcon } from "lucide-react"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"
import { FALLBACK_NODE_ICON, getNodeIcon } from "./node-icons"

describe("node icons", () => {
  it("maps the chained-workflow trigger to the Workflow icon", () => {
    expect(getNodeIcon("trigger.workflow.completed")).toBe(WorkflowIcon)
  })

  it("returns an icon component for every declared node kind (fallback included)", () => {
    for (const kind of WORKFLOW_NODE_KINDS) {
      expect(typeof getNodeIcon(kind)).not.toBe("undefined")
    }
  })

  /**
   * The defect this file was split to fix: the palette and the canvas read two
   * different tables, so ~120 kinds (every agent, plan, goal, memory and
   * scheduler node among them) showed one glyph in the sidebar and a generic
   * `Workflow` the moment they were dropped.
   */
  it("agrees with the palette for every catalogued kind", () => {
    const mismatched: string[] = []
    for (const kind of WORKFLOW_NODE_KINDS) {
      const entry = nodeCatalogEntry(kind)
      const paletteIcon = (LucideIcons as unknown as Record<string, unknown>)[entry.iconName]
      if (!paletteIcon) continue
      if (getNodeIcon(kind) !== paletteIcon) mismatched.push(kind)
    }
    expect(mismatched).toEqual([])
  })

  it("no longer falls back to the generic glyph for the agent nodes", () => {
    for (const kind of [
      "action.agent.turn",
      "action.plan.create",
      "action.memory.recall",
    ] as const) {
      expect(getNodeIcon(kind)).not.toBe(FALLBACK_NODE_ICON)
    }
  })
})
