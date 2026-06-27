import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SubagentModelsPanel } from "./SubagentModelsPanel"
import { ThemeProvider } from "../../theme/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import type { SubagentModelRow } from "../../runtime/subagent-models-model"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const rows: SubagentModelRow[] = [
  {
    id: "planner",
    name: "planner",
    description: "plans the work",
    source: "inherit",
    provider: "anthropic",
    inheritsProvider: true,
    providerOptions: ["anthropic", "openai"],
    modelOptions: ["m1", "m2"],
  },
  {
    id: "reviewer",
    name: "reviewer",
    description: "reviews the diff",
    source: "override",
    provider: "openai",
    model: "gpt-4o",
    inheritsProvider: false,
    providerOptions: ["anthropic", "openai"],
    modelOptions: ["gpt-4o", "gpt-4o-mini"],
  },
]

function wrap(props: Partial<React.ComponentProps<typeof SubagentModelsPanel>> = {}) {
  const cb = {
    onMove: jest.fn(),
    onCycleModel: jest.fn(),
    onCycleProvider: jest.fn(),
    onReset: jest.fn(),
    onClose: jest.fn(),
  }
  const result = render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <SubagentModelsPanel rows={rows} index={0} {...cb} {...props} />
    </ThemeProvider>
  )
  return { ...result, ...cb }
}

describe("SubagentModelsPanel", () => {
  beforeEach(() => __resetInk())

  it("renders the header, each agent's provider/model and source badge", () => {
    const { container } = wrap()
    const text = container.textContent ?? ""
    expect(text).toContain("Subagent models")
    expect(text).toContain("2 agents")
    expect(text).toContain("1 overridden")
    expect(text).toContain("planner")
    expect(text).toContain("reviewer")
    expect(text).toContain("gpt-4o")
    expect(text).toContain("override")
    expect(text).toContain("inherit")
  })

  it("shows 'default' for a row with no effective model", () => {
    const { container } = wrap()
    expect(container.textContent ?? "").toContain("default") // planner inherits → default
  })

  it("shows the focused row's description", () => {
    const { container } = wrap({ index: 0 })
    expect(container.textContent ?? "").toContain("plans the work")
  })

  it("moves with ↑/↓", () => {
    const { onMove } = wrap()
    key("", { downArrow: true })
    expect(onMove).toHaveBeenCalledWith(1)
    key("", { upArrow: true })
    expect(onMove).toHaveBeenCalledWith(-1)
  })

  it("cycles the model with ←/→ on the focused row", () => {
    const { onCycleModel } = wrap({ index: 1 })
    key("", { rightArrow: true })
    expect(onCycleModel).toHaveBeenCalledWith(rows[1], 1)
    key("", { leftArrow: true })
    expect(onCycleModel).toHaveBeenCalledWith(rows[1], -1)
  })

  it("cycles the provider with p / P", () => {
    const { onCycleProvider } = wrap({ index: 0 })
    key("p")
    expect(onCycleProvider).toHaveBeenCalledWith(rows[0], 1)
    key("P")
    expect(onCycleProvider).toHaveBeenCalledWith(rows[0], -1)
  })

  it("resets the focused row with r", () => {
    const { onReset } = wrap({ index: 1 })
    key("r")
    expect(onReset).toHaveBeenCalledWith(rows[1])
  })

  it("closes on Esc", () => {
    const { onClose } = wrap()
    key("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("renders an empty state with no rows", () => {
    const { container } = wrap({ rows: [] })
    expect(container.textContent ?? "").toContain("no subagents found")
  })
})
