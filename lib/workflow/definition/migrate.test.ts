import { migrateWorkflow } from "./migrate"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

function baseV1(): VisualWorkflow {
  return {
    id: "wf_x",
    schemaVersion: 1,
    name: "legacy",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: "flow.loop",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Loop", params: { mode: "forEach" } },
      },
    ],
    edges: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
  }
}

describe("migrateWorkflow", () => {
  it("stamps schemaVersion 2 on a v1 workflow", () => {
    const out = migrateWorkflow(baseV1())
    expect(out.schemaVersion).toBe(2)
  })

  it("leaves a legacy flat flow.loop at typeVersion 1 (transform mode preserved)", () => {
    const out = migrateWorkflow(baseV1())
    expect(out.nodes[0].typeVersion).toBe(1)
    expect(out.nodes[0].type).toBe("flow.loop")
  })

  it("is idempotent — a v2 workflow passes through unchanged (same reference)", () => {
    const v2 = migrateWorkflow(baseV1())
    expect(migrateWorkflow(v2)).toBe(v2)
  })

  it("preserves unknown / additive fields", () => {
    const wf = { ...baseV1(), variables: { API_KEY: "x" }, staticData: { acc: 1 } }
    const out = migrateWorkflow(wf)
    expect(out.variables).toEqual({ API_KEY: "x" })
    expect(out.staticData).toEqual({ acc: 1 })
  })
})
