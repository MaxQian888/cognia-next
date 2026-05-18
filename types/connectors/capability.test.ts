import {
  A2UI_COMPONENT_KINDS,
  ALL_CAPABILITIES,
  buildA2UICapabilityMatrix,
  componentKindsByLevel,
  defaultDegradeChain,
  hasCapability,
  type Capability,
} from "./capability"

describe("capability flags", () => {
  it("ALL_CAPABILITIES includes the core text/markdown/file family", () => {
    for (const c of [
      "send.text",
      "send.markdown",
      "send.image",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "send.a2ui",
      "edit",
      "delete",
      "typing",
      "history.fetch",
    ] as Capability[]) {
      expect(ALL_CAPABILITIES).toContain(c)
    }
  })

  it("hasCapability matches case-sensitively", () => {
    const adapter = ["send.text", "send.markdown"] as Capability[]
    expect(hasCapability(adapter, "send.text")).toBe(true)
    expect(hasCapability(adapter, "send.image")).toBe(false)
  })

  it("defaultDegradeChain falls card → markdown → text", () => {
    expect(defaultDegradeChain("card")).toEqual(["card", "markdown", "text"])
    expect(defaultDegradeChain("markdown")).toEqual(["markdown", "text"])
    expect(defaultDegradeChain("text")).toEqual(["text"])
  })

  it("defaultDegradeChain for a2ui ends in text", () => {
    expect(defaultDegradeChain("a2ui")).toEqual(["a2ui", "card", "markdown", "text"])
  })
})

describe("A2UICapabilityMatrix", () => {
  it("buildA2UICapabilityMatrix defaults every kind to fallback", () => {
    const matrix = buildA2UICapabilityMatrix({})
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(matrix[kind]).toBe("fallback")
    }
  })

  it("buildA2UICapabilityMatrix honours per-kind overrides", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Image: "native",
      Chart: "unsupported",
      Table: "unsupported",
    })
    expect(matrix.Text).toBe("native")
    expect(matrix.Image).toBe("native")
    expect(matrix.Chart).toBe("unsupported")
    expect(matrix.Table).toBe("unsupported")
    expect(matrix.Button).toBe("fallback")
  })

  it("buildA2UICapabilityMatrix returns a frozen object", () => {
    const matrix = buildA2UICapabilityMatrix({})
    expect(Object.isFrozen(matrix)).toBe(true)
  })

  it("componentKindsByLevel slices the matrix by support level", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Button: "native",
      Card: "fallback",
      Chart: "unsupported",
      Table: "unsupported",
    })
    expect(componentKindsByLevel(matrix, "native").sort()).toEqual(["Button", "Text"])
    expect(componentKindsByLevel(matrix, "unsupported").sort()).toEqual(["Chart", "Table"])
    // Every other catalogue kind defaults to fallback — verify a sample.
    expect(componentKindsByLevel(matrix, "fallback")).toContain("Card")
    expect(componentKindsByLevel(matrix, "fallback")).toContain("Image")
  })
})
