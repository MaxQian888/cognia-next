import {
  filterWorkflows,
  hasTriggerNode,
  isFilterActive,
  matchesQuery,
  resolveDragMoveIds,
  sortWorkflows,
} from "./library-filter"
import { DEFAULT_WORKFLOW_FILTERS } from "@/stores/workflow"
import type { WorkflowRow } from "@/types/workflow/visual"

function wf(partial: Partial<WorkflowRow> & { id: string; name: string }): WorkflowRow {
  return {
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    ...partial,
  } as WorkflowRow
}

function triggerNode(): WorkflowRow["nodes"][number] {
  return {
    id: "n1",
    type: "trigger.manual",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: "Run", params: {} },
  }
}

describe("matchesQuery", () => {
  it("passes on empty/whitespace query", () => {
    expect(matchesQuery(wf({ id: "a", name: "Alpha" }), "")).toBe(true)
    expect(matchesQuery(wf({ id: "a", name: "Alpha" }), "   ")).toBe(true)
  })

  it("matches name, description, and tags case-insensitively", () => {
    const row = wf({ id: "a", name: "Daily Digest", description: "sends Email", tags: ["Ops"] })
    expect(matchesQuery(row, "digest")).toBe(true)
    expect(matchesQuery(row, "email")).toBe(true)
    expect(matchesQuery(row, "ops")).toBe(true)
    expect(matchesQuery(row, "nope")).toBe(false)
  })
})

describe("hasTriggerNode", () => {
  it("detects a trigger.* node", () => {
    expect(hasTriggerNode(wf({ id: "a", name: "A", nodes: [triggerNode()] }))).toBe(true)
    expect(hasTriggerNode(wf({ id: "a", name: "A" }))).toBe(false)
  })
})

describe("filterWorkflows", () => {
  const rows = [
    wf({ id: "u", name: "User flow" }),
    wf({ id: "t", name: "Template flow", isTemplate: true }),
    wf({ id: "b", name: "Built-in flow", isBuiltIn: true }),
    wf({ id: "trig", name: "Triggered", nodes: [triggerNode()] }),
  ]
  const base = { query: "", recentlyFailedIds: new Set<string>() }

  it("type=user excludes templates and built-ins", () => {
    const out = filterWorkflows(rows, {
      ...base,
      filters: { ...DEFAULT_WORKFLOW_FILTERS, type: "user" },
    })
    expect(out.map((r) => r.id).sort()).toEqual(["trig", "u"])
  })

  it("type=template keeps only templates", () => {
    const out = filterWorkflows(rows, {
      ...base,
      filters: { ...DEFAULT_WORKFLOW_FILTERS, type: "template" },
    })
    expect(out.map((r) => r.id)).toEqual(["t"])
  })

  it("type=builtin keeps only built-ins", () => {
    const out = filterWorkflows(rows, {
      ...base,
      filters: { ...DEFAULT_WORKFLOW_FILTERS, type: "builtin" },
    })
    expect(out.map((r) => r.id)).toEqual(["b"])
  })

  it("hasTrigger keeps only workflows with a trigger node", () => {
    const out = filterWorkflows(rows, {
      ...base,
      filters: { ...DEFAULT_WORKFLOW_FILTERS, hasTrigger: true },
    })
    expect(out.map((r) => r.id)).toEqual(["trig"])
  })

  it("recentlyFailed keeps only ids in the failed set", () => {
    const out = filterWorkflows(rows, {
      ...base,
      filters: { ...DEFAULT_WORKFLOW_FILTERS, recentlyFailed: true },
      recentlyFailedIds: new Set(["b"]),
    })
    expect(out.map((r) => r.id)).toEqual(["b"])
  })

  it("combines query with filters", () => {
    const out = filterWorkflows(rows, {
      ...base,
      query: "flow",
      filters: { ...DEFAULT_WORKFLOW_FILTERS, type: "user" },
    })
    expect(out.map((r) => r.id)).toEqual(["u"])
  })
})

describe("sortWorkflows", () => {
  const rows = [
    wf({ id: "a", name: "Bravo", createdAt: 10, updatedAt: 30 }),
    wf({ id: "b", name: "Alpha", createdAt: 20, updatedAt: 10 }),
    wf({ id: "c", name: "Charlie", createdAt: 5, updatedAt: 20 }),
  ]
  const counts = new Map([
    ["a", 1],
    ["b", 5],
    ["c", 3],
  ])

  it("does not mutate the input", () => {
    const before = rows.map((r) => r.id)
    sortWorkflows(rows, "nameAsc", counts)
    expect(rows.map((r) => r.id)).toEqual(before)
  })

  it("sorts by name asc / desc", () => {
    expect(sortWorkflows(rows, "nameAsc", counts).map((r) => r.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ])
    expect(sortWorkflows(rows, "nameDesc", counts).map((r) => r.name)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ])
  })

  it("sorts by updated and created newest-first", () => {
    expect(sortWorkflows(rows, "updated", counts).map((r) => r.id)).toEqual(["a", "c", "b"])
    expect(sortWorkflows(rows, "created", counts).map((r) => r.id)).toEqual(["b", "a", "c"])
  })

  it("sorts by run count descending", () => {
    expect(sortWorkflows(rows, "runCount", counts).map((r) => r.id)).toEqual(["b", "c", "a"])
  })
})

describe("resolveDragMoveIds", () => {
  it("moves the whole selection when the dragged item is selected", () => {
    expect(resolveDragMoveIds("b", new Set(["a", "b", "c"])).sort()).toEqual(["a", "b", "c"])
  })

  it("moves only the dragged item when it is not in the selection", () => {
    expect(resolveDragMoveIds("z", new Set(["a", "b"]))).toEqual(["z"])
  })

  it("moves only the dragged item when nothing is selected", () => {
    expect(resolveDragMoveIds("z", new Set())).toEqual(["z"])
  })
})

describe("isFilterActive", () => {
  it("is false for empty query + default filters", () => {
    expect(isFilterActive("", DEFAULT_WORKFLOW_FILTERS)).toBe(false)
  })

  it("is true when a query or any non-default filter is set", () => {
    expect(isFilterActive("x", DEFAULT_WORKFLOW_FILTERS)).toBe(true)
    expect(isFilterActive("", { ...DEFAULT_WORKFLOW_FILTERS, type: "user" })).toBe(true)
    expect(isFilterActive("", { ...DEFAULT_WORKFLOW_FILTERS, hasTrigger: true })).toBe(true)
    expect(isFilterActive("", { ...DEFAULT_WORKFLOW_FILTERS, recentlyFailed: true })).toBe(true)
  })
})
