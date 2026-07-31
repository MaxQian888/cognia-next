/**
 * @jest-environment node
 */
import { clampIndex, filterByQuery, filterRowsByQuery, moveIndex } from "./select-list-state"

describe("moveIndex", () => {
  it("wraps forward and backward", () => {
    expect(moveIndex(0, 1, 3)).toBe(1)
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(0, -1, 3)).toBe(2)
  })
  it("returns 0 for an empty list", () => {
    expect(moveIndex(0, 1, 0)).toBe(0)
  })
})

describe("clampIndex", () => {
  it("clamps to the list bounds", () => {
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(-2, 3)).toBe(0)
    expect(clampIndex(1, 3)).toBe(1)
  })
  it("returns 0 for an empty list", () => {
    expect(clampIndex(2, 0)).toBe(0)
  })
})

describe("filterByQuery", () => {
  const models = [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5",
    "google/gemini-3-pro",
  ]
  it("returns the list unchanged for a blank query", () => {
    expect(filterByQuery(models, "")).toBe(models)
    expect(filterByQuery(models, "   ")).toBe(models)
  })
  it("matches case-insensitive substrings", () => {
    expect(filterByQuery(models, "OPUS")).toEqual(["anthropic/claude-opus-4-8"])
  })
  it("requires every whitespace token to match (AND)", () => {
    expect(filterByQuery(models, "claude sonnet")).toEqual(["anthropic/claude-sonnet-4-6"])
    expect(filterByQuery(models, "claude gpt")).toEqual([])
  })
  it("returns an empty list when nothing matches", () => {
    expect(filterByQuery(models, "llama")).toEqual([])
  })
})

describe("filterRowsByQuery", () => {
  const rows = [
    { label: "Permission mode", hint: "default" },
    { label: "Model", hint: "claude-opus" },
    { label: "Provider", hint: "openrouter" },
  ]
  it("returns the same array reference for a blank query", () => {
    expect(filterRowsByQuery(rows, "", (r) => r.label)).toBe(rows)
  })
  it("matches against the projected text (label + hint)", () => {
    const text = (r: (typeof rows)[number]) => `${r.label} ${r.hint}`
    expect(filterRowsByQuery(rows, "opus", text)).toEqual([{ label: "Model", hint: "claude-opus" }])
  })
  it("applies AND semantics across tokens", () => {
    const text = (r: (typeof rows)[number]) => `${r.label} ${r.hint}`
    expect(filterRowsByQuery(rows, "provider openrouter", text)).toHaveLength(1)
    expect(filterRowsByQuery(rows, "provider opus", text)).toEqual([])
  })
})
