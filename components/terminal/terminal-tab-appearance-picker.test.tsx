import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { TerminalTabAppearancePicker } from "./terminal-tab-appearance-picker"

const messages = {
  terminal: {
    tab: {
      appearance: {
        trigger: "Customize appearance",
        colorLabel: "Color",
        iconLabel: "Icon",
        colors: {
          none: "None",
          red: "Red",
          orange: "Orange",
          yellow: "Yellow",
          green: "Green",
          cyan: "Cyan",
          blue: "Blue",
          purple: "Purple",
          pink: "Pink",
        },
        icons: {
          none: "None",
          terminal: "Terminal",
          server: "Server",
          database: "Database",
          globe: "Globe",
          code: "Code",
          bug: "Bug",
          rocket: "Rocket",
          container: "Container",
        },
      },
    },
  },
}

function renderPicker(
  props: Partial<React.ComponentProps<typeof TerminalTabAppearancePicker>> = {}
) {
  const defaultProps = {
    color: "none" as const,
    icon: "none" as const,
    onChange: jest.fn(),
    ...props,
  }
  // Mounted inside a real, open context menu: the swatches are `ContextMenuItem`s
  // so that Radix's roving focus and typeahead can reach them (a plain button in
  // a `role="radiogroup"` is invisible to both), and those require a menu
  // context. This is also the only surface that renders the picker.
  const result = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button data-testid="trigger">tab</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TerminalTabAppearancePicker {...defaultProps} />
        </ContextMenuContent>
      </ContextMenu>
    </NextIntlClientProvider>
  )
  fireEvent.contextMenu(screen.getByTestId("trigger"))
  return result
}

describe("TerminalTabAppearancePicker", () => {
  it("renders its grids inline, with no surface of its own", () => {
    // It used to wrap itself in a Popover with a colour-dot trigger. The tab
    // context menu embeds it in a submenu, which is already a positioned,
    // dismissable surface — a nested Popover only fights it for focus.
    renderPicker()
    expect(screen.getByTestId("tab-appearance-grids")).toBeInTheDocument()
    expect(screen.queryByTestId("tab-appearance-trigger")).not.toBeInTheDocument()
  })

  it("renders all 9 color options", () => {
    renderPicker()
    const colors = ["none", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]
    for (const color of colors) {
      expect(screen.getByTestId(`tab-color-${color}`)).toBeInTheDocument()
    }
  })

  it("renders all 9 icon options", () => {
    renderPicker()
    const icons = [
      "none",
      "terminal",
      "server",
      "database",
      "globe",
      "code",
      "bug",
      "rocket",
      "container",
    ]
    for (const icon of icons) {
      expect(screen.getByTestId(`tab-icon-${icon}`)).toBeInTheDocument()
    }
  })

  it("reports a colour and an icon independently", () => {
    // Partial by design: the store's `setTabAppearance` leaves an omitted
    // field alone, so picking a colour must not reset the icon.
    const onChange = jest.fn()
    renderPicker({ onChange })
    fireEvent.click(screen.getByTestId("tab-color-red"))
    expect(onChange).toHaveBeenCalledWith({ color: "red" })

    fireEvent.click(screen.getByTestId("tab-icon-database"))
    expect(onChange).toHaveBeenLastCalledWith({ icon: "database" })
  })

  it("marks the current color as checked", () => {
    renderPicker({ color: "blue" })
    expect(screen.getByTestId("tab-color-blue")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("tab-color-red")).toHaveAttribute("aria-checked", "false")
  })

  it("marks the current icon as checked", () => {
    renderPicker({ icon: "rocket" })
    expect(screen.getByTestId("tab-icon-rocket")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("tab-icon-none")).toHaveAttribute("aria-checked", "false")
  })
})
