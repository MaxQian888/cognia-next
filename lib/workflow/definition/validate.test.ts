import { validateGraphIntegrity, validateWorkflow, visualWorkflowSchema } from "./validate"
import type { VisualWorkflow } from "@/types/workflow/visual"

function baseWorkflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf_x",
    schemaVersion: 1,
    name: "Test",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "n1",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n2",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: {} },
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    ...overrides,
  }
}

describe("visualWorkflowSchema", () => {
  it("accepts a well-formed workflow", () => {
    const result = visualWorkflowSchema.safeParse(baseWorkflow())
    expect(result.success).toBe(true)
  })

  it("rejects an empty name", () => {
    const result = visualWorkflowSchema.safeParse(baseWorkflow({ name: "" }))
    expect(result.success).toBe(false)
  })

  it("accepts schemaVersion 2 and nodes carrying a parentId", () => {
    const wf = baseWorkflow({ schemaVersion: 2 })
    wf.nodes[1] = { ...wf.nodes[1], parentId: "n1" }
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(true)
  })

  it("rejects an unknown schemaVersion", () => {
    const wf = baseWorkflow({ schemaVersion: 3 as unknown as VisualWorkflow["schemaVersion"] })
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(false)
  })

  it("accepts a plugin-namespaced node kind", () => {
    const wf = baseWorkflow()
    wf.nodes[1] = {
      ...wf.nodes[1],
      // Plugin namespace passes the regex; the registry decides if it actually
      // resolves at run time.
      type: "myplugin.action.foo" as VisualWorkflow["nodes"][number]["type"],
    }
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(true)
  })

  it("rejects an unknown / mis-formed node kind", () => {
    const wf = baseWorkflow()
    wf.nodes[1] = {
      ...wf.nodes[1],
      type: "INVALID" as VisualWorkflow["nodes"][number]["type"],
    }
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(false)
  })

  it("rejects negative timeoutMs and zero concurrency", () => {
    expect(
      visualWorkflowSchema.safeParse(
        baseWorkflow({
          settings: {
            errorPolicy: "stop",
            timeoutMs: -1,
            concurrency: 0,
            retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
          },
        })
      ).success
    ).toBe(false)
  })
})

describe("validateGraphIntegrity", () => {
  it("flags duplicate node ids", () => {
    const wf = baseWorkflow()
    wf.nodes.push({ ...wf.nodes[0] })
    const r = validateGraphIntegrity(wf)
    expect(r.errors.some((e) => e.includes("Duplicate node id"))).toBe(true)
  })

  it("flags dangling edge endpoints", () => {
    const wf = baseWorkflow()
    wf.edges.push({ id: "e2", source: "n1", target: "n_missing" })
    const r = validateGraphIntegrity(wf)
    expect(r.errors.some((e) => e.includes("unknown node"))).toBe(true)
  })

  it("warns when no trigger is present", () => {
    const wf = baseWorkflow()
    wf.nodes = wf.nodes.filter((n) => !n.type.startsWith("trigger."))
    const r = validateGraphIntegrity(wf)
    expect(r.warnings.some((w) => w.includes("no trigger"))).toBe(true)
  })

  it("rejects a generic cycle", () => {
    const wf = baseWorkflow()
    // Form a cycle n1 → n2 → n1 (no loop/wait node on the path).
    wf.edges.push({ id: "e2", source: "n2", target: "n1" })
    const r = validateGraphIntegrity(wf)
    expect(r.errors.some((e) => e.includes("Cycle"))).toBe(true)
  })

  it("permits a cycle that goes through a flow.loop node", () => {
    const wf = baseWorkflow()
    wf.nodes.push({
      id: "n_loop",
      type: "flow.loop",
      typeVersion: 1,
      position: { x: 400, y: 0 },
      data: { label: "Loop", params: {} },
    })
    wf.edges.push({ id: "e2", source: "n2", target: "n_loop" })
    wf.edges.push({ id: "e3", source: "n_loop", target: "n2" })
    const r = validateGraphIntegrity(wf)
    expect(r.errors).toEqual([])
  })
})

describe("validateWorkflow", () => {
  it("returns ok and surfaces warnings on a valid graph with no trigger", () => {
    const wf = baseWorkflow()
    wf.nodes = wf.nodes.filter((n) => !n.type.startsWith("trigger."))
    wf.edges = []
    const r = validateWorkflow(wf)
    if (!r.ok) throw new Error(`Expected ok, got errors: ${r.errors.join(", ")}`)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it("collates zod errors into readable strings", () => {
    const r = validateWorkflow({ ...baseWorkflow(), name: "" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("Expected error")
    expect(r.errors.some((e) => e.includes("name"))).toBe(true)
  })
})
