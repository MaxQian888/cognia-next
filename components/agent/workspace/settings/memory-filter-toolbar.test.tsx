/**
 * @jest-environment jsdom
 */
import { applyMemoryFilter, EMPTY_MEMORY_FILTER, type MemoryFilter } from "./memory-filter-toolbar"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

const entry = (over: Partial<SharedMemoryEntry>): SharedMemoryEntry => ({
  key: "k",
  value: "v",
  writtenBy: "w",
  writtenAt: new Date(),
  version: 1,
  ...over,
})

describe("applyMemoryFilter", () => {
  const entries = [
    entry({ key: "alpha", value: "hello world", writtenBy: "tm-1", tags: ["plan"] }),
    entry({ key: "beta", value: { n: 2 }, writtenBy: "tm-2", tags: ["result"] }),
    entry({ key: "gamma", value: "another note", writtenBy: "tm-1", tags: ["plan", "draft"] }),
  ]

  it("returns all entries with the empty filter", () => {
    expect(applyMemoryFilter(entries, EMPTY_MEMORY_FILTER)).toHaveLength(3)
  })

  it("filters by writer", () => {
    const f: MemoryFilter = { ...EMPTY_MEMORY_FILTER, writerId: "tm-1" }
    expect(applyMemoryFilter(entries, f).map((e) => e.key)).toEqual(["alpha", "gamma"])
  })

  it("filters by tag", () => {
    const f: MemoryFilter = { ...EMPTY_MEMORY_FILTER, tag: "result" }
    expect(applyMemoryFilter(entries, f).map((e) => e.key)).toEqual(["beta"])
  })

  it("free-text searches key and stringified value", () => {
    expect(
      applyMemoryFilter(entries, { ...EMPTY_MEMORY_FILTER, text: "world" }).map((e) => e.key)
    ).toEqual(["alpha"])
    // Value of beta is an object — stringified search hits the JSON.
    expect(
      applyMemoryFilter(entries, { ...EMPTY_MEMORY_FILTER, text: '"n":2' }).map((e) => e.key)
    ).toEqual(["beta"])
  })

  it("combines criteria (AND)", () => {
    const f: MemoryFilter = { writerId: "tm-1", tag: "draft", text: "note" }
    expect(applyMemoryFilter(entries, f).map((e) => e.key)).toEqual(["gamma"])
  })
})
