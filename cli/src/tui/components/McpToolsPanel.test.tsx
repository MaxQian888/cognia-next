import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { McpToolsPanel } from "./McpToolsPanel"
import type { McpPanelTool } from "../runtime/mcp-panel-model"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const tools: McpPanelTool[] = [
  { name: "create_issue", description: "open an issue", enabled: true },
  { name: "list_repos", description: "list repos", enabled: false },
  { name: "search_code", enabled: true },
]

function wrap(props: Partial<React.ComponentProps<typeof McpToolsPanel>> = {}) {
  const onToggle = jest.fn()
  const onBack = jest.fn()
  const result = render(
    <McpToolsPanel server="github" tools={tools} onToggle={onToggle} onBack={onBack} {...props} />
  )
  return { ...result, onToggle, onBack }
}

describe("McpToolsPanel", () => {
  beforeEach(() => __resetInk())

  it("lists the server's tools and the enabled count", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("github · tools")
    expect(text).toContain("2/3 enabled")
    expect(text).toContain("create_issue")
    expect(text).toContain("open an issue")
  })

  it("Space toggles the highlighted tool and persists the new state", () => {
    const { onToggle, container } = wrap()
    key(" ") // row 0 = create_issue (enabled → disabled)
    expect(onToggle).toHaveBeenCalledWith("create_issue", false)
    // Header reflects the optimistic local flip.
    expect(container.textContent ?? "").toContain("1/3 enabled")
  })

  it("enables a disabled tool", () => {
    const { onToggle } = wrap()
    key("", { downArrow: true }) // row 1 = list_repos (disabled)
    key(" ")
    expect(onToggle).toHaveBeenCalledWith("list_repos", true)
  })

  it("filters by name or description", () => {
    const { container } = wrap()
    key("repo")
    expect(container.textContent ?? "").toContain("list_repos")
    expect(container.textContent ?? "").not.toContain("create_issue")
  })

  it("clamps at the top and windows a long tool list with scroll hints", () => {
    const many: McpPanelTool[] = Array.from({ length: 25 }, (_, i) => ({
      name: `tool_${i}`,
      enabled: i % 2 === 0,
    }))
    const onToggle = jest.fn()
    const onBack = jest.fn()
    const { container } = render(
      <McpToolsPanel server="s" tools={many} onToggle={onToggle} onBack={onBack} maxRows={5} />
    )
    key("", { upArrow: true }) // clamp at top
    for (let i = 0; i < 8; i++) key("", { downArrow: true })
    expect(container.textContent ?? "").toContain("more")
  })

  it("shows a no-matches hint and ignores toggle when nothing matches", () => {
    const { container, onToggle } = wrap()
    for (const ch of "zzzz") key(ch)
    expect(container.textContent ?? "").toContain("no matches")
    key(" ")
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("Enter also toggles the highlighted tool", () => {
    const { onToggle } = wrap()
    key("", { return: true })
    expect(onToggle).toHaveBeenCalledWith("create_issue", false)
  })

  it("Escape returns to the server panel (after clearing any filter)", () => {
    const { onBack } = wrap()
    key("repo")
    key("", { escape: true }) // clears filter
    expect(onBack).not.toHaveBeenCalled()
    key("", { escape: true }) // goes back
    expect(onBack).toHaveBeenCalled()
  })
})
