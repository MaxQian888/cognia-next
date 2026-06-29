import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { QuickActionsPanel } from "./QuickActionsPanel"
import { ThemeProvider } from "../../theme/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { absoluteTopLeft } from "../../input/element-position"
import type { QuickActionRow } from "../../state/types"

jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const rows: QuickActionRow[] = [
  { id: "mode", label: "⚖ Permission mode", hint: "default", command: "/mode" },
  { id: "model", label: "✦ Model", hint: "claude", command: "/model" },
  { id: "settings", label: "⚙ Settings", hint: "open", command: "/settings" },
]

function wrap(props: Partial<React.ComponentProps<typeof QuickActionsPanel>> = {}) {
  const cb = { onRun: jest.fn(), onClose: jest.fn() }
  const result = render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <QuickActionsPanel rows={rows} {...cb} {...props} />
    </ThemeProvider>
  )
  return { ...result, ...cb }
}

describe("QuickActionsPanel", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("renders the title and every row's label + hint", () => {
    const { container } = wrap()
    const text = container.textContent ?? ""
    expect(text).toContain("Quick actions")
    expect(text).toContain("Permission mode")
    expect(text).toContain("Model")
    expect(text).toContain("Settings")
    expect(text).toContain("default")
  })

  it("runs the highlighted row's command on Enter", () => {
    const { onRun } = wrap()
    key("", { return: true })
    expect(onRun).toHaveBeenCalledWith("/mode")
  })

  it("moves the highlight with ↓ before running", () => {
    const { onRun } = wrap()
    key("", { downArrow: true })
    key("", { return: true })
    expect(onRun).toHaveBeenCalledWith("/model")
  })

  it("wraps the highlight past the ends", () => {
    const { onRun } = wrap()
    key("", { upArrow: true }) // from 0 wraps to last
    key("", { return: true })
    expect(onRun).toHaveBeenCalledWith("/settings")
  })

  it("runs the clicked row's command", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onRun } = wrap()
    // border(1) + title(1) → first row at SGR row 3.
    key("[<0;5;3M")
    expect(onRun).toHaveBeenCalledWith("/mode")
  })

  it("closes on Esc", () => {
    const { onClose } = wrap()
    key("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
