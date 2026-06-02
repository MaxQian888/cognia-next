import { resolveNodeIo, toItems, flattenSchema } from "./node-io-data"

const nodes = [
  { id: "n_a", data: { label: "Alpha" } },
  { id: "n_b", data: { label: "Beta" } },
  { id: "n_c", data: { label: "Gamma" } },
]
const edges = [
  { source: "n_a", target: "n_c" },
  { source: "n_b", target: "n_c" },
]

describe("resolveNodeIo — output precedence", () => {
  it("prefers pinned data over run output", () => {
    const io = resolveNodeIo({
      nodeId: "n_c",
      nodes,
      edges,
      latestOutputs: { n_c: { fromRun: true } },
      pinData: { n_c: { fromPin: true } },
    })
    expect(io.output).toEqual({ value: { fromPin: true }, pinned: true, source: "pin" })
  })

  it("falls back to run output when no pin", () => {
    const io = resolveNodeIo({
      nodeId: "n_c",
      nodes,
      edges,
      latestOutputs: { n_c: { fromRun: true } },
      pinData: {},
    })
    expect(io.output).toEqual({ value: { fromRun: true }, pinned: false, source: "run" })
  })

  it("reports source 'none' when neither pin nor run data exists", () => {
    const io = resolveNodeIo({ nodeId: "n_c", nodes, edges, latestOutputs: {}, pinData: {} })
    expect(io.output).toEqual({ value: undefined, pinned: false, source: "none" })
  })
})

describe("resolveNodeIo — inputs", () => {
  it("lists one entry per upstream node in edge order, with labels + precedence", () => {
    const io = resolveNodeIo({
      nodeId: "n_c",
      nodes,
      edges,
      latestOutputs: { n_a: { a: 1 } },
      pinData: { n_b: { b: 2 } },
    })
    expect(io.inputs).toEqual([
      { upstreamNodeId: "n_a", upstreamLabel: "Alpha", value: { a: 1 }, source: "run" },
      { upstreamNodeId: "n_b", upstreamLabel: "Beta", value: { b: 2 }, source: "pin" },
    ])
  })

  it("deduplicates multiple edges from the same upstream node", () => {
    const io = resolveNodeIo({
      nodeId: "n_c",
      nodes,
      edges: [
        { source: "n_a", target: "n_c" },
        { source: "n_a", target: "n_c" },
      ],
      latestOutputs: {},
      pinData: {},
    })
    expect(io.inputs).toHaveLength(1)
    expect(io.inputs[0].upstreamNodeId).toBe("n_a")
    expect(io.inputs[0].source).toBe("none")
  })

  it("returns no inputs for a node with no incoming edges", () => {
    const io = resolveNodeIo({ nodeId: "n_a", nodes, edges, latestOutputs: {}, pinData: {} })
    expect(io.inputs).toEqual([])
  })
})

describe("toItems", () => {
  it("returns the array itself for array values", () => {
    expect(toItems([1, 2, 3])).toEqual([1, 2, 3])
  })
  it("wraps a single object in a one-element array", () => {
    expect(toItems({ a: 1 })).toEqual([{ a: 1 }])
  })
  it("wraps a primitive", () => {
    expect(toItems("hi")).toEqual(["hi"])
    expect(toItems(0)).toEqual([0])
    expect(toItems(null)).toEqual([null])
  })
  it("returns an empty array for undefined", () => {
    expect(toItems(undefined)).toEqual([])
  })
})

describe("flattenSchema", () => {
  it("flattens nested objects and arrays into accessor rows", () => {
    const rows = flattenSchema({
      completion: "hello",
      usage: { totalTokens: 42 },
      items: [{ id: 9 }],
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(byPath["completion"]).toMatchObject({ type: "string", segments: ["completion"] })
    expect(byPath["usage"]).toMatchObject({ type: "object" })
    expect(byPath["usage.totalTokens"]).toMatchObject({ type: "number", sample: "42" })
    expect(byPath["items"]).toMatchObject({ type: "array", sample: "[1]" })
    expect(byPath["items[0].id"]).toMatchObject({ type: "number", segments: ["items", 0, "id"] })
  })

  it("does not emit a row for the root value", () => {
    const rows = flattenSchema({ a: 1 })
    expect(rows.some((r) => r.segments.length === 0)).toBe(false)
  })

  it("tags null and boolean types and previews strings", () => {
    const rows = flattenSchema({
      n: null,
      ok: true,
      s: "verylongstringthatexceedsthelimit".repeat(3),
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(byPath["n"].type).toBe("null")
    expect(byPath["ok"]).toMatchObject({ type: "boolean", sample: "true" })
    expect(byPath["s"].sample.endsWith("…")).toBe(true)
  })

  it("respects the depth cap", () => {
    const rows = flattenSchema({ a: { b: { c: { d: { e: 1 } } } } }, { maxDepth: 2 })
    expect(rows.some((r) => r.path === "a.b")).toBe(true)
    expect(rows.some((r) => r.path === "a.b.c")).toBe(false)
  })

  it("respects the row cap", () => {
    const big: Record<string, number> = {}
    for (let i = 0; i < 50; i++) big[`k${i}`] = i
    const rows = flattenSchema(big, { maxRows: 10 })
    expect(rows.length).toBeLessThanOrEqual(10)
  })

  it("returns no rows for a primitive root", () => {
    expect(flattenSchema("hi")).toEqual([])
    expect(flattenSchema(undefined)).toEqual([])
  })

  it("caps rows while walking a large array", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ i }))
    const rows = flattenSchema(arr, { maxRows: 5 })
    expect(rows.length).toBeLessThanOrEqual(5)
  })

  it("treats non-JSON values (functions) as string-typed defensively", () => {
    const rows = flattenSchema({ fn: () => 1 })
    const row = rows.find((r) => r.path === "fn")
    expect(row?.type).toBe("string")
    expect(typeof row?.sample).toBe("string")
  })
})
