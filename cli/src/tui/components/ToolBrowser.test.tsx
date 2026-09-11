import React from "react"
import { render, act } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import { ToolBrowser, type ToolBrowserEntry } from "./ToolBrowser"
import { TuiInputProvider } from "../input/input-router"
import { CliI18nProvider } from "../i18n"
const entries: ToolBrowserEntry[] = Array.from({ length: 20 }, (_, i) => ({
  id: `tool-${i}`,
  name: `tool-${i}`,
  source: "builtin",
  description: `purpose ${i}`,
  detail: Array.from({ length: 60 }, (_, j) => `parameter ${i}/${j}`).join("\n"),
}))
const fire = (input = "", key: Record<string, boolean> = {}) => act(() => __fireInput(input, key))
beforeEach(() => __resetInk())
function tree(
  props: Partial<React.ComponentProps<typeof ToolBrowser>> = {},
  locale: "en" | "zh-CN" = "en"
) {
  return (
    <CliI18nProvider locale={locale}>
      <TuiInputProvider>
        <ToolBrowser
          title="Tools"
          entries={entries}
          maxRows={6}
          width={100}
          onClose={jest.fn()}
          {...props}
        />
      </TuiInputProvider>
    </CliI18nProvider>
  )
}
it("pages through the catalog and restores the selected page after full details", () => {
  const view = render(tree())
  expect(view.container.textContent).toContain("Page 1/4")
  fire("", { pageDown: true })
  expect(view.container.textContent).toContain("Page 2/4")
  fire("", { return: true })
  expect(view.container.textContent).toContain("parameter 5/0")
  fire("G")
  expect(view.container.textContent).toContain("parameter 5/59")
  fire("", { escape: true })
  expect(view.container.textContent).toContain("Page 2/4")
  fire("", { leftArrow: true })
  expect(view.container.textContent).toContain("Page 1/4")
})
it("filters descriptions across all pages and resets pagination including empty matches", () => {
  const onClose = jest.fn()
  const view = render(tree({ onClose }))
  fire("", { rightArrow: true })
  fire("purpose 19")
  expect(view.container.textContent).toContain("Page 1/1")
  expect(view.container.textContent).toContain("tool-19")
  fire("missing")
  expect(view.container.textContent).toContain("Page 0/0")
  fire("", { return: true })
  fire("", { escape: true })
  expect(onClose).not.toHaveBeenCalled()
  fire("", { escape: true })
  expect(onClose).toHaveBeenCalled()
})
it("keeps selection across resize and supports bilingual status and missing descriptions", () => {
  const view = render(tree())
  fire("", { downArrow: true })
  view.rerender(
    tree({ entries: [{ ...entries[1], description: "", enabled: false }], width: 60 }, "zh-CN")
  )
  fire("", { return: true })
  expect(view.container.textContent).toContain("未提供工具说明")
  expect(view.container.textContent).toContain("已禁用")
})
it("separates inspection from explicit toggles and preserves spaces in a search", () => {
  const onToggle = jest.fn()
  render(tree({ onToggle }))
  fire(" ")
  expect(onToggle).toHaveBeenCalledWith(entries[0])
  fire("purpose")
  fire(" ")
  expect(onToggle).toHaveBeenCalledTimes(1)
  fire("", { return: true })
  expect(onToggle).toHaveBeenCalledTimes(1)
})
