import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SkillPanel } from "./SkillPanel"
import type { SkillPanelRow } from "../runtime/skill-panel-model"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const rows: SkillPanelRow[] = [
  {
    id: "web-search",
    name: "Web Search",
    origin: "claude",
    category: "development",
    enabled: true,
    usageCount: 5,
    errorCount: 0,
  },
  { id: "pdf-export", name: "PDF Export", origin: null, enabled: false, errorCount: 0 },
  { id: "broken", name: "Broken Skill", origin: "project", enabled: false, errorCount: 2 },
]

function wrap(props: Partial<React.ComponentProps<typeof SkillPanel>> = {}) {
  const cb = {
    onToggle: jest.fn(),
    onSetAll: jest.fn(),
    onShow: jest.fn(),
    onCreate: jest.fn(),
    onDelete: jest.fn(),
    onCancel: jest.fn(),
    onToggleLoadMode: jest.fn(),
  }
  const result = render(<SkillPanel rows={rows} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("SkillPanel", () => {
  beforeEach(() => __resetInk())

  it("shows the summary and rich per-row metadata", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("Skills · 3")
    expect(text).toContain("1 on")
    expect(text).toContain("1 with issues")
    expect(text).toContain("Web Search")
    expect(text).toContain("claude · development · used 5×")
    expect(text).toContain("2 issues")
  })

  it("Space toggles the highlighted skill", () => {
    const { onToggle } = wrap()
    key(" ")
    expect(onToggle).toHaveBeenCalledWith("web-search")
  })

  it("Enter opens the detail pager", () => {
    const { onShow } = wrap()
    key("", { downArrow: true })
    key("", { return: true })
    expect(onShow).toHaveBeenCalledWith("pdf-export")
  })

  it("Ctrl+N creates and Ctrl+X deletes the highlighted skill", () => {
    const { onCreate, onDelete } = wrap()
    key("n", { ctrl: true })
    expect(onCreate).toHaveBeenCalled()
    key("x", { ctrl: true })
    expect(onDelete).toHaveBeenCalledWith("web-search")
  })

  it("Ctrl+A enables and Ctrl+D disables every filtered row (全开全关)", () => {
    const { onSetAll } = wrap()
    key("a", { ctrl: true })
    expect(onSetAll).toHaveBeenCalledWith(["web-search", "pdf-export", "broken"], true)
    key("d", { ctrl: true })
    expect(onSetAll).toHaveBeenCalledWith(["web-search", "pdf-export", "broken"], false)
  })

  it("bulk keys act on the filtered subset, not the whole list", () => {
    const { onSetAll } = wrap()
    key("pdf")
    key("a", { ctrl: true })
    expect(onSetAll).toHaveBeenCalledWith(["pdf-export"], true)
  })

  it("Ctrl+A is a no-op when nothing matches", () => {
    const { onSetAll } = wrap()
    for (const ch of "zzzz") key(ch)
    key("a", { ctrl: true })
    expect(onSetAll).not.toHaveBeenCalled()
  })

  it("Ctrl+T cycles the load mode and the header reflects it", () => {
    const { onToggleLoadMode, container } = wrap({ loadMode: "name" })
    expect(container.textContent ?? "").toContain("load: name-only")
    key("t", { ctrl: true })
    expect(onToggleLoadMode).toHaveBeenCalled()
  })

  it("shows the full-bodies load mode label", () => {
    const text = wrap({ loadMode: "full" }).container.textContent ?? ""
    expect(text).toContain("load: full")
  })

  it("filters by name", () => {
    const { container } = wrap()
    key("pdf")
    expect(container.textContent ?? "").toContain("PDF Export")
    expect(container.textContent ?? "").not.toContain("Web Search")
  })

  it("clamps at the top and windows a long list with scroll hints", () => {
    const many: SkillPanelRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `s${i}`,
      name: `Skill ${i}`,
      origin: null,
      enabled: false,
      errorCount: 0,
    }))
    const cb = {
      onToggle: jest.fn(),
      onSetAll: jest.fn(),
      onShow: jest.fn(),
      onCreate: jest.fn(),
      onDelete: jest.fn(),
      onCancel: jest.fn(),
    }
    const { container } = render(<SkillPanel rows={many} {...cb} maxRows={5} />)
    key("", { upArrow: true }) // clamp at top
    for (let i = 0; i < 8; i++) key("", { downArrow: true })
    expect(container.textContent ?? "").toContain("more")
  })

  it("shows a no-matches hint and ignores actions when nothing matches", () => {
    const { container, onToggle, onShow } = wrap()
    for (const ch of "zzzz") key(ch)
    expect(container.textContent ?? "").toContain("no matches")
    key(" ")
    key("", { return: true })
    expect(onToggle).not.toHaveBeenCalled()
    expect(onShow).not.toHaveBeenCalled()
  })

  it("Escape clears the filter, then cancels", () => {
    const { onCancel, container } = wrap()
    key("pdf")
    key("", { escape: true })
    expect(onCancel).not.toHaveBeenCalled()
    expect(container.textContent ?? "").toContain("Web Search")
    key("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })
})
