import type { Memory } from "./types/memory"
import { assembleProceduralBlock } from "./procedural"

let seq = 0
function mem(text: string, over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: `m${seq}`,
    scope: "global",
    type: "procedural",
    text,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

describe("assembleProceduralBlock", () => {
  it("returns null when there are no procedural memories", () => {
    expect(assembleProceduralBlock([])).toBeNull()
    expect(assembleProceduralBlock([mem("x", { type: "semantic" })])).toBeNull()
  })

  it("ignores invalidated procedural memories", () => {
    expect(assembleProceduralBlock([mem("x", { status: "invalidated" })])).toBeNull()
  })

  it("renders a heading + bullet per memory", () => {
    const block = assembleProceduralBlock([mem("Always reply in Chinese"), mem("Prefer pnpm")])
    expect(block).toContain("## Working preferences you've learned")
    expect(block).toContain("- Always reply in Chinese")
    expect(block).toContain("- Prefer pnpm")
  })

  it("orders pinned first, then importance, then recency", () => {
    const block = assembleProceduralBlock([
      mem("low", { importance: 2, lastAccessedAt: 1 }),
      mem("pinned", { importance: 1, pinned: true }),
      mem("high", { importance: 9 }),
    ])!
    const lines = block.split("\n").slice(1) // drop heading
    expect(lines[0]).toBe("- pinned")
    expect(lines[1]).toBe("- high")
    expect(lines[2]).toBe("- low")
  })

  it("caps the block to the token budget", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      mem(`Preference number ${i} with some descriptive padding text`)
    )
    const block = assembleProceduralBlock(many, { maxTokens: 50 })!
    const lines = block.split("\n").slice(1)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(many.length)
  })

  it("honors a custom heading", () => {
    const block = assembleProceduralBlock([mem("x")], { heading: "## Custom" })!
    expect(block.startsWith("## Custom\n")).toBe(true)
  })

  it("returns null when the budget cannot fit even one line", () => {
    const block = assembleProceduralBlock(
      [mem("a very long procedural instruction that will not fit")],
      { maxTokens: 1 }
    )
    expect(block).toBeNull()
  })
})
