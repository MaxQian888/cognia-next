import { CliI18nProvider } from "../../i18n"
import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { Help, helpNameColumn } from "./Help"

describe("helpNameColumn", () => {
  it("sizes the column to the longest name, clamped at both ends", () => {
    // Short catalogue: the floor keeps the descriptions off the names.
    expect(helpNameColumn(["help", "clear"])).toBe(12)
    // A 12-character name needs its slash plus a gutter.
    expect(helpNameColumn(["help", "capabilities"])).toBe(14)
    // One pathological name cannot push every description off a narrow panel.
    expect(helpNameColumn(["a-very-long-command-name"])).toBe(18)
    expect(helpNameColumn([])).toBe(12)
  })
})

describe("Help", () => {
  beforeEach(() => __resetInk())

  it("renders the command catalog and key hints", () => {
    const { container } = render(<Help onClose={() => {}} viewportRows={16} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Commands")
    expect(text).toContain("/model")
    expect(text).toContain("Shift+Enter")
    expect(text).toContain("PgUp/PgDn scroll")
    expect(text).toContain("esc close")
  })

  it("closes on Enter", () => {
    const onClose = jest.fn()
    render(<Help onClose={onClose} />)
    __fireInput("", { return: true })
    expect(onClose).toHaveBeenCalled()
  })
})

it("shows configured shortcuts and terminal alternatives", () => {
  const { container } = render(
    <Help
      onClose={() => {}}
      keybindings={{ historySearch: "ctrl+x ctrl+r", collapseAll: "ctrl+d" }}
    />
  )
  expect(container.textContent).toContain("Ctrl+X Ctrl+R history search")
  expect(container.textContent).toContain("Ctrl+D expand/collapse")
  expect(container.textContent).toContain("Ctrl+X Ctrl+G")
  expect(container.textContent).toContain("tmux")
})

it("localizes built-in help and honors an overridden workflow shortcut", () => {
  const onClose = jest.fn()
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <Help onClose={onClose} keybindings={{ workflowInspect: "ctrl+x ctrl+w" }} />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("切换模型")
  expect(container.textContent).toContain("Ctrl+X Ctrl+W")
  expect(container.textContent).not.toContain("Ctrl+X Ctrl+G")
  act(() => __fireInput("", { downArrow: true }))
  expect(onClose).not.toHaveBeenCalled()
  __fireInput("", { escape: true })
  expect(onClose).toHaveBeenCalledTimes(1)
})
