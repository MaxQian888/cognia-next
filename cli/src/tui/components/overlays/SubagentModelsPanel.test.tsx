import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SubagentModelsPanel } from "./SubagentModelsPanel"
import { ThemeProvider } from "../../theme/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { absoluteTopLeft } from "../../input/element-position"
import type { SubagentModelRow } from "../../runtime/subagent-models-model"

jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

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
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("focuses a clicked row, skipping the focused row's description line", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onMove } = wrap()
    // border(1)+header(1) → planner at SGR row 3, its description at row 4,
    // reviewer at row 5. Clicking row 5 should focus reviewer (index 1).
    key("[<0;5;5M")
    expect(onMove).toHaveBeenCalledWith(1)
  })

  it("ignores a click on the focused row's description line", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onMove } = wrap()
    key("[<0;5;4M") // the description row
    expect(onMove).not.toHaveBeenCalled()
  })

  it("nudges the focus on the mouse wheel", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onMove } = wrap()
    key("[<65;5;5M") // wheel down
    expect(onMove).toHaveBeenCalledWith(1)
  })

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

describe("name column", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("cuts a name at the column cap so the provider/model cells stay in column", () => {
    // Agent names come from user-authored markdown under .cognia/agents/, so
    // nothing bounds them. Padding a 37-column name into a 24-column column
    // used to shift this row's whole right-hand side out of line.
    const long: SubagentModelRow[] = [
      { ...rows[0], id: "long", name: "database-migration-and-schema-auditor" },
      rows[1],
    ]
    const { container } = wrap({ rows: long })
    const text = container.textContent ?? ""
    expect(text).toContain("database-migration-and-…")
    expect(text).not.toContain("database-migration-and-schema-auditor")
  })

  it("still pads a short name out to the column", () => {
    const { container } = wrap({ rows: [{ ...rows[0], name: "ci" }, rows[1]] })
    // "reviewer" is the longest name, so the column is eight wide and "ci"
    // carries six trailing spaces before the provider cell.
    expect(container.textContent ?? "").toContain("ci      ")
  })
})
