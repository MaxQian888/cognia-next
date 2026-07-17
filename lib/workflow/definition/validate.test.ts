import {
  collectGraphIntegrityIssues,
  collectUnauthorizedCycleNodes,
  validateGraphIntegrity,
  validateWorkflow,
  visualWorkflowSchema,
} from "./validate"
import { DEFAULT_MAX_CONCURRENCY, type VisualWorkflow } from "@/types/workflow/visual"

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

  it("preserves per-node errorHandling through safeParse (zod strips unknown keys)", () => {
    const wf = baseWorkflow()
    wf.nodes[1].data.errorHandling = {
      retry: { maxRetries: 3, retryIntervalMs: 250, backoff: "fixed" },
      onError: "defaultValue",
      defaultValue: { completion: "fallback" },
    }
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.nodes[1].data.errorHandling).toEqual(wf.nodes[1].data.errorHandling)
    }
  })

  it("rejects malformed errorHandling (negative retries / unknown onError)", () => {
    const wf = baseWorkflow()
    wf.nodes[1].data.errorHandling = {
      retry: { maxRetries: -1, retryIntervalMs: 0, backoff: "fixed" },
    } as unknown as VisualWorkflow["nodes"][number]["data"]["errorHandling"]
    expect(visualWorkflowSchema.safeParse(wf).success).toBe(false)

    const wf2 = baseWorkflow()
    wf2.nodes[1].data.errorHandling = {
      onError: "explode",
    } as unknown as VisualWorkflow["nodes"][number]["data"]["errorHandling"]
    expect(visualWorkflowSchema.safeParse(wf2).success).toBe(false)
  })

  it("accepts error-kind edges", () => {
    const wf = baseWorkflow()
    wf.edges = [
      { id: "e1", source: "n2", sourceHandle: "error", target: "n1", data: { kind: "error" } },
    ]
    expect(visualWorkflowSchema.safeParse(wf).success).toBe(true)
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

  describe("loop-body integrity (schemaVersion 2)", () => {
    function withLoop(extra: Partial<VisualWorkflow> = {}): VisualWorkflow {
      const wf = baseWorkflow({ schemaVersion: 2 })
      wf.nodes = [
        wf.nodes[0], // n1 trigger
        {
          id: "loop",
          type: "flow.loop",
          typeVersion: 2,
          position: { x: 100, y: 0 },
          data: { label: "Loop", params: { mode: "forEach", source: "{{ $trigger.payload.x }}" } },
        },
        {
          id: "child",
          type: "flow.set",
          typeVersion: 1,
          parentId: "loop",
          position: { x: 10, y: 10 },
          data: { label: "Body", params: { variable: "v", value: "1" } },
        },
      ]
      wf.edges = [{ id: "e1", source: "n1", target: "loop" }]
      return { ...wf, ...extra }
    }

    it("accepts a well-formed loop container with a body child", () => {
      const r = validateWorkflow(withLoop())
      expect(r.ok).toBe(true)
    })

    it("rejects a parentId referencing a missing node", () => {
      const wf = withLoop()
      wf.nodes[2] = { ...wf.nodes[2], parentId: "ghost" }
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/parentId/i)
    })

    it("rejects a parentId pointing at a non-container node", () => {
      const wf = withLoop()
      wf.nodes[2] = { ...wf.nodes[2], parentId: "n1" }
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/container/i)
    })

    it("rejects flow.break / flow.continue outside a loop body", () => {
      const wf = withLoop()
      wf.nodes.push({
        id: "stray",
        type: "flow.break",
        typeVersion: 1,
        position: { x: 300, y: 0 },
        data: { label: "Break", params: {} },
      })
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/loop body/i)
    })

    it("accepts flow.break inside a loop body", () => {
      const wf = withLoop()
      wf.nodes.push({
        id: "brk",
        type: "flow.break",
        typeVersion: 1,
        parentId: "loop",
        position: { x: 20, y: 20 },
        data: { label: "Break", params: {} },
      })
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(true)
    })

    it("rejects edges that cross the container boundary", () => {
      const wf = withLoop()
      wf.edges.push({ id: "e2", source: "n1", target: "child" })
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/container boundary/i)
    })

    it("rejects a self-parented container", () => {
      const wf = withLoop()
      wf.nodes[1] = { ...wf.nodes[1], parentId: "loop" }
      const r = validateWorkflow(wf)
      expect(r.ok).toBe(false)
    })
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

  it("backfills maxConcurrency to the shared default when absent", () => {
    // baseWorkflow's settings carry no maxConcurrency — the schema must
    // backfill DEFAULT_MAX_CONCURRENCY so the orchestrator, editor, and seed
    // all execute legacy blobs at the same width.
    const result = visualWorkflowSchema.safeParse(baseWorkflow())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.settings.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY)
    }
  })

  it("keeps an explicit maxConcurrency untouched", () => {
    const wf = baseWorkflow()
    wf.settings = { ...wf.settings, maxConcurrency: 1 }
    const result = visualWorkflowSchema.safeParse(wf)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.settings.maxConcurrency).toBe(1)
    }
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

  it("rejects a cycle even when a flow.loop node sits on it (back-edges never iterate)", () => {
    // The scheduler drops back-edges, so this graph used to validate and then
    // silently run each node ONCE. It must now fail with guidance pointing at
    // the loop CONTAINER instead.
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
    const cycleError = r.errors.find((e) => e.includes("Cycle"))
    expect(cycleError).toBeDefined()
    expect(cycleError).toMatch(/flow\.loop container/)
  })

  it("rejects a cycle through a flow.wait node (event mode is not a back-edge)", () => {
    const wf = baseWorkflow()
    wf.nodes.push({
      id: "n_wait",
      type: "flow.wait",
      typeVersion: 1,
      position: { x: 400, y: 0 },
      data: { label: "Wait", params: { mode: "duration", durationMs: 10 } },
    })
    wf.edges.push({ id: "e2", source: "n2", target: "n_wait" })
    wf.edges.push({ id: "e3", source: "n_wait", target: "n2" })
    const r = validateGraphIntegrity(wf)
    expect(r.errors.some((e) => e.includes("Cycle"))).toBe(true)
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

describe("collectUnauthorizedCycleNodes", () => {
  it("returns empty for a DAG", () => {
    expect(collectUnauthorizedCycleNodes(baseWorkflow()).size).toBe(0)
  })

  it("returns the cycle nodes for an unauthorized cycle", () => {
    const wf = baseWorkflow()
    wf.edges = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n1" },
    ]
    const cycle = collectUnauthorizedCycleNodes(wf)
    expect(cycle.has("n1")).toBe(true)
    expect(cycle.has("n2")).toBe(true)
  })

  it("returns the cycle nodes even when a flow.loop sits on the cycle (no authorization)", () => {
    const wf = baseWorkflow()
    wf.nodes[1] = { ...wf.nodes[1], type: "flow.loop", typeVersion: 2 }
    wf.edges = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n1" },
    ]
    const cycle = collectUnauthorizedCycleNodes(wf)
    expect(cycle.has("n1")).toBe(true)
    expect(cycle.has("n2")).toBe(true)
  })

  it("does not flag a loop@2 container graph (body nesting is not a cycle)", () => {
    const wf = baseWorkflow({ schemaVersion: 2 })
    wf.nodes = [
      wf.nodes[0],
      {
        id: "loop",
        type: "flow.loop",
        typeVersion: 2,
        position: { x: 100, y: 0 },
        data: { label: "Loop", params: { mode: "forEach", source: "{{ $trigger.payload.x }}" } },
      },
      {
        id: "child",
        type: "flow.set",
        typeVersion: 1,
        parentId: "loop",
        position: { x: 10, y: 10 },
        data: { label: "Body", params: { variable: "v", value: "1" } },
      },
    ]
    wf.edges = [{ id: "e1", source: "n1", target: "loop" }]
    expect(collectUnauthorizedCycleNodes(wf).size).toBe(0)
    expect(validateWorkflow(wf).ok).toBe(true)
  })
})

describe("collectGraphIntegrityIssues", () => {
  it("returns no issues for a well-formed workflow", () => {
    expect(collectGraphIntegrityIssues(baseWorkflow())).toEqual([])
  })

  it("flags a dangling edge target with the edge id and ref", () => {
    const wf = baseWorkflow()
    wf.edges = [{ id: "e9", source: "n1", target: "ghost" }]
    const issues = collectGraphIntegrityIssues(wf)
    const dangling = issues.find((i) => i.code === "danglingTarget")
    expect(dangling).toMatchObject({ edgeId: "e9", params: { ref: "ghost" } })
  })

  it("warns when there is no trigger", () => {
    const wf = baseWorkflow()
    wf.nodes[0] = { ...wf.nodes[0], type: "ai.prompt" }
    const issues = collectGraphIntegrityIssues(wf)
    expect(issues.some((i) => i.code === "missingTrigger" && i.severity === "warning")).toBe(true)
  })

  it("emits one clickable graphCycle issue per node on an unauthorized cycle", () => {
    const wf = baseWorkflow()
    wf.edges = [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n1" },
    ]
    const cycleIssues = collectGraphIntegrityIssues(wf).filter((i) => i.code === "graphCycle")
    expect(cycleIssues).toHaveLength(2)
    expect(cycleIssues.every((i) => typeof i.nodeId === "string")).toBe(true)
    // validateGraphIntegrity re-collapses them into a single string line.
    expect(
      validateGraphIntegrity(wf).errors.filter((e) => e.includes("Cycle detected"))
    ).toHaveLength(1)
  })
})
