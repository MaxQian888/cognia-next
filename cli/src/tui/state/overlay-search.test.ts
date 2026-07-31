/**
 * @jest-environment node
 */
import {
  SEARCHABLE_MIN,
  filterInspectItems,
  filterProviderOptions,
  filterQuickActions,
  filterSelectItems,
  filterSessionItems,
} from "./overlay-search"
import type { ProviderOption } from "../commands/provider-options"
import type { InspectItem, QuickActionRow, SelectItem, SessionSummary } from "./types"

describe("SEARCHABLE_MIN", () => {
  it("is a small positive threshold", () => {
    expect(SEARCHABLE_MIN).toBeGreaterThan(0)
    expect(SEARCHABLE_MIN).toBe(8)
  })
})

describe("filterSelectItems", () => {
  const items: SelectItem[] = [
    { id: "a", label: "Alpha plugin", hint: "on" },
    { id: "b", label: "Beta tool", hint: "off" },
    { id: "c", label: "Gamma", hint: undefined },
  ]
  it("matches label and hint", () => {
    expect(filterSelectItems(items, "alpha").map((i) => i.id)).toEqual(["a"])
    expect(filterSelectItems(items, "off").map((i) => i.id)).toEqual(["b"])
  })
  it("tolerates a missing hint", () => {
    expect(filterSelectItems(items, "gamma").map((i) => i.id)).toEqual(["c"])
  })
  it("returns all rows for a blank query", () => {
    expect(filterSelectItems(items, "")).toBe(items)
  })
})

describe("filterSessionItems", () => {
  const items: SessionSummary[] = [
    { sessionId: "1", title: "Fix the login bug", turns: 4, updatedAt: 0 },
    { sessionId: "2", title: "Add dark mode", turns: 2, updatedAt: 0 },
  ]
  it("matches against the title", () => {
    expect(filterSessionItems(items, "dark").map((s) => s.sessionId)).toEqual(["2"])
  })
})

describe("filterInspectItems", () => {
  const items: InspectItem[] = [
    { cellId: "x", label: "bash", summary: "pnpm test", lines: 12, isError: false },
    { cellId: "y", label: "read", summary: "src/app.ts", lines: 3, isError: false },
  ]
  it("matches label and summary", () => {
    expect(filterInspectItems(items, "pnpm").map((i) => i.cellId)).toEqual(["x"])
    expect(filterInspectItems(items, "app.ts").map((i) => i.cellId)).toEqual(["y"])
  })
  it("tolerates a missing summary (matches on label only)", () => {
    const noSummary: InspectItem[] = [
      {
        cellId: "z",
        label: "subagent",
        summary: undefined as unknown as string,
        lines: 0,
        isError: false,
      },
    ]
    expect(filterInspectItems(noSummary, "subagent").map((i) => i.cellId)).toEqual(["z"])
    expect(filterInspectItems(noSummary, "nope")).toEqual([])
  })
})

describe("filterQuickActions", () => {
  const rows: QuickActionRow[] = [
    { id: "model", label: "✦ Model", hint: "claude-opus", command: "/model" },
    { id: "diff", label: "± Git diff", hint: "working-tree changes", command: "/diff" },
  ]
  it("matches label and hint", () => {
    expect(filterQuickActions(rows, "git").map((r) => r.id)).toEqual(["diff"])
    expect(filterQuickActions(rows, "opus").map((r) => r.id)).toEqual(["model"])
  })
  it("tolerates a row with no hint (matches on label only)", () => {
    const noHint: QuickActionRow[] = [{ id: "bare", label: "Bare command", command: "/bare" }]
    expect(filterQuickActions(noHint, "bare").map((r) => r.id)).toEqual(["bare"])
    expect(filterQuickActions(noHint, "missing")).toEqual([])
  })
})

describe("filterProviderOptions", () => {
  const opts: ProviderOption[] = [
    { id: "anthropic", name: "Anthropic", configured: true, auth: "api key", requiresKey: true },
    {
      id: "openrouter",
      name: "OpenRouter",
      configured: false,
      auth: "no credential",
      requiresKey: true,
    },
    { id: "ollama", name: "Ollama", configured: false, auth: "no credential", requiresKey: false },
  ]
  it("matches on both the display name and the catalog id", () => {
    expect(filterProviderOptions(opts, "anthropic").map((o) => o.id)).toEqual(["anthropic"])
    // "or" appears in the OpenRouter id — id search, not just name.
    expect(filterProviderOptions(opts, "openrouter").map((o) => o.id)).toEqual(["openrouter"])
  })
  it("returns all rows for a blank query", () => {
    expect(filterProviderOptions(opts, "")).toBe(opts)
  })
})
