import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

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
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TerminalTabAppearancePicker {...defaultProps} />
    </NextIntlClientProvider>
  )
}

describe("TerminalTabAppearancePicker", () => {
  it("renders a trigger button", () => {
    renderPicker()
    expect(screen.getByTestId("tab-appearance-trigger")).toBeInTheDocument()
  })

  it("opens the popover when trigger is clicked", async () => {
    renderPicker()
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    expect(await screen.findByTestId("tab-appearance-popover")).toBeInTheDocument()
  })

  it("renders all 9 color options", async () => {
    renderPicker()
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
    const colors = ["none", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]
    for (const color of colors) {
      expect(screen.getByTestId(`tab-color-${color}`)).toBeInTheDocument()
    }
  })

  it("renders all 9 icon options", async () => {
    renderPicker()
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
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

  it("calls onChange with color when a color is clicked", async () => {
    const onChange = jest.fn()
    renderPicker({ onChange })
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
    fireEvent.click(screen.getByTestId("tab-color-red"))
    expect(onChange).toHaveBeenCalledWith({ color: "red" })
  })

  it("calls onChange with icon when an icon is clicked", async () => {
    const onChange = jest.fn()
    renderPicker({ onChange })
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
    fireEvent.click(screen.getByTestId("tab-icon-database"))
    expect(onChange).toHaveBeenCalledWith({ icon: "database" })
  })

  it("marks the current color as checked", async () => {
    renderPicker({ color: "blue" })
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
    const blueBtn = screen.getByTestId("tab-color-blue")
    expect(blueBtn).toHaveAttribute("aria-checked", "true")
    const redBtn = screen.getByTestId("tab-color-red")
    expect(redBtn).toHaveAttribute("aria-checked", "false")
  })

  it("marks the current icon as checked", async () => {
    renderPicker({ icon: "rocket" })
    fireEvent.click(screen.getByTestId("tab-appearance-trigger"))
    await screen.findByTestId("tab-appearance-popover")
    const rocketBtn = screen.getByTestId("tab-icon-rocket")
    expect(rocketBtn).toHaveAttribute("aria-checked", "true")
    const noneBtn = screen.getByTestId("tab-icon-none")
    expect(noneBtn).toHaveAttribute("aria-checked", "false")
  })

  it("renders a custom trigger when provided", () => {
    renderPicker({ trigger: <button data-testid="custom-trigger">Custom</button> })
    expect(screen.getByTestId("custom-trigger")).toBeInTheDocument()
    expect(screen.queryByTestId("tab-appearance-trigger")).not.toBeInTheDocument()
  })
})
