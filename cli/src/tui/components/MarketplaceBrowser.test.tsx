import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { MarketplaceBrowser } from "./MarketplaceBrowser"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"
import type { MarketplaceBrowseEntry } from "../runtime/marketplace-filter"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const entries: MarketplaceBrowseEntry[] = [
  {
    installRef: "a/x",
    name: "Alpha",
    description: "first",
    downloads: 10,
    rating: 4.5,
    author: "amy",
  },
  { installRef: "b/y", name: "Beta", description: "second", downloads: 100, author: "ben" },
  { installRef: "c/z", name: "Gamma", description: "third", signed: true },
]

function wrap(props: Partial<React.ComponentProps<typeof MarketplaceBrowser>> = {}) {
  const onSelect = jest.fn()
  const onCancel = jest.fn()
  const result = render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <MarketplaceBrowser entries={entries} onSelect={onSelect} onCancel={onCancel} {...props} />
    </ThemeProvider>
  )
  return { ...result, onSelect, onCancel }
}

describe("MarketplaceBrowser", () => {
  beforeEach(() => __resetInk())

  it("lists all entries with section tabs", () => {
    const { container } = wrap()
    const text = container.textContent ?? ""
    expect(text).toContain("Marketplace · 3 plugins")
    expect(text).toContain("[all]")
    expect(text).toContain("Alpha")
    expect(text).toContain("Gamma")
  })

  it("filters as the user types", () => {
    const { container } = wrap()
    key("g")
    expect(container.textContent ?? "").toContain("Gamma")
    expect(container.textContent ?? "").not.toContain("Alpha")
  })

  it("cycles sections with Tab (signed filters to signed entries)", () => {
    const { container } = wrap()
    // all → popular → top-rated → signed
    key("", { tab: true })
    key("", { tab: true })
    key("", { tab: true })
    const text = container.textContent ?? ""
    expect(text).toContain("[signed]")
    expect(text).toContain("Gamma")
    expect(text).not.toContain("Alpha")
  })

  it("previews the highlighted entry on Enter", () => {
    const { onSelect } = wrap()
    key("", { downArrow: true })
    key("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("b/y")
  })

  it("cancels on Escape", () => {
    const { onCancel } = wrap()
    key("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("shows a no-matches hint when the query excludes everything", () => {
    const { container } = wrap()
    for (const ch of "zzzz") key(ch)
    expect(container.textContent ?? "").toContain("no matches")
  })

  it("moves the highlight up and down, clamped at the ends", () => {
    const { onSelect } = wrap()
    key("", { downArrow: true })
    key("", { downArrow: true })
    key("", { upArrow: true })
    key("", { return: true })
    // down,down,up from row 0 → row 1 (Beta).
    expect(onSelect).toHaveBeenCalledWith("b/y")
  })

  it("edits the query with Backspace", () => {
    const { container } = wrap()
    key("g")
    key("a")
    expect(container.textContent ?? "").toContain("Gamma")
    key("", { backspace: true })
    key("", { backspace: true })
    // Query cleared → all entries visible again.
    expect(container.textContent ?? "").toContain("Alpha")
  })

  it("windows a long catalog with scroll hints", () => {
    const many: MarketplaceBrowseEntry[] = Array.from({ length: 30 }, (_, i) => ({
      installRef: `o/p${i}`,
      name: `Plug ${i}`,
    }))
    const onSelect = jest.fn()
    const { container } = render(
      <ThemeProvider palette={BUILTIN_THEMES.ansi}>
        <MarketplaceBrowser entries={many} onSelect={onSelect} onCancel={() => {}} maxRows={5} />
      </ThemeProvider>
    )
    for (let i = 0; i < 10; i++) key("", { downArrow: true })
    const text = container.textContent ?? ""
    expect(text).toContain("more")
  })
})
