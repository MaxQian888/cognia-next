import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import { CliI18nProvider } from "../../i18n"
import { TuiInputProvider } from "../../input/input-router"
import type { HookPanelRow } from "../../runtime/hooks-controller"
import { HooksOverlay, type HooksOverlayProps } from "./HooksOverlay"

const rows: HookPanelRow[] = [
  {
    id: "builtin:a",
    label: "Context loader",
    event: "SessionStart",
    source: "builtin",
    builtinId: "a",
    enabled: true,
    detail: Array.from({ length: 60 }, (_, index) => `detail line ${index}`).join("\n"),
  },
  {
    id: "user:b",
    label: "Review changes",
    event: "PreToolUse",
    source: "cognia",
    sourcePath: "/home/config.json",
    detail: "command: guard.sh",
  },
  {
    id: "claude:c",
    label: "Finish notification",
    event: "Stop",
    source: "claude",
    detail: "command: notify.sh",
  },
]
function fire(input: string, key: Record<string, boolean> = {}) {
  act(() => __fireInput(input, key))
}
function props(overrides: Partial<HooksOverlayProps> = {}): HooksOverlayProps {
  return {
    rows,
    diagnostics: [],
    width: 80,
    maxRows: 10,
    onToggle: jest.fn(),
    onEdit: jest.fn(),
    onRefresh: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  }
}
function tree(options: HooksOverlayProps, locale: "en" | "zh-CN" = "en") {
  return (
    <CliI18nProvider locale={locale}>
      <TuiInputProvider>
        <HooksOverlay {...options} />
      </TuiInputProvider>
    </CliI18nProvider>
  )
}
beforeEach(() => __resetInk())

it("lists configured hooks with source and builtin state in Chinese", () => {
  const { container } = render(tree(props(), "zh-CN"))
  expect(container.textContent).toContain("已配置的 Hook")
  expect(container.textContent).toContain("内置")
  expect(container.textContent).toContain("[✓] Context loader")
  expect(container.textContent).toContain("PreToolUse")
  expect(container.textContent).not.toContain("Active hooks")
})

it("opens full details, scrolls to the end and returns before closing the panel", () => {
  const options = props()
  const { container } = render(tree(options))
  fire("", { return: true })
  expect(container.textContent).toContain("detail line 0")
  expect(container.textContent).not.toContain("detail line 59")
  fire("G")
  expect(container.textContent).toContain("detail line 59")
  fire("", { escape: true })
  expect(container.textContent).toContain("Configured hooks")
  expect(options.onClose).not.toHaveBeenCalled()
  fire("", { escape: true })
  expect(options.onClose).toHaveBeenCalledTimes(1)
})

it("toggles only builtins in an empty search and preserves spaces in typed queries", () => {
  const options = props()
  const { container } = render(tree(options))
  fire(" ")
  expect(options.onToggle).toHaveBeenCalledWith(rows[0])
  fire("Review")
  fire(" ")
  fire("changes")
  expect(options.onToggle).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("Review changes")
  expect(container.textContent).not.toContain("Context loader")
  fire("", { return: true })
  expect(container.textContent).toContain("guard.sh")
})

it("keeps selection by id after rows are reordered and dispatches explicit configuration actions", () => {
  const options = props()
  const view = render(tree(options))
  fire("", { downArrow: true })
  view.rerender(tree({ ...options, rows: [rows[2], rows[0], rows[1]] }))
  fire("", { return: true })
  expect(view.container.textContent).toContain("guard.sh")
  fire("", { escape: true })
  fire("r", { ctrl: true })
  fire("e", { ctrl: true })
  fire("l", { ctrl: true })
  expect(options.onRefresh).toHaveBeenCalledTimes(1)
  expect(options.onEdit).toHaveBeenNthCalledWith(1, "cognia")
  expect(options.onEdit).toHaveBeenNthCalledWith(2, "claude")
})

it("shows all diagnostics in a scrollable document", () => {
  const diagnostics = Array.from({ length: 30 }, (_, index) => `failure ${index}`)
  const { container } = render(tree(props({ rows: [], diagnostics })))
  fire("", { return: true })
  expect(container.textContent).toContain("failure 0")
  fire("G")
  expect(container.textContent).toContain("failure 29")
  fire("", { escape: true })
  expect(container.textContent).toContain("Configuration diagnostics (30)")
})

it("handles empty results and removed selection without invoking mutation actions", () => {
  const options = props({ rows: [] })
  const view = render(tree(options))
  expect(view.container.textContent).toContain("No hooks configured")
  fire("", { return: true })
  fire(" ")
  expect(options.onToggle).not.toHaveBeenCalled()
  view.rerender(tree({ ...options, rows }))
  fire("no such hook")
  expect(view.container.textContent).toContain("No matching hooks")
  fire("", { downArrow: true })
  fire("", { return: true })
  expect(options.onToggle).not.toHaveBeenCalled()
})
