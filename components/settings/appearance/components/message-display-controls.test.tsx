/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"

import { MessageDisplayControls } from "./message-display-controls"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) =>
    ReactForMock.createElement(
      "select",
      {
        value,
        onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
      },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    ReactForMock.createElement("option", { value }, children),
}))

describe("MessageDisplayControls", () => {
  it("offers inherit and the three presets for a session", () => {
    render(<MessageDisplayControls allowInherit value={undefined} onChange={jest.fn()} />)

    const preset = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    expect(preset.value).toBe("inherit")
    expect(preset.querySelectorAll("option")).toHaveLength(4)
  })

  it("shows inherited global values without copying global overrides into a session edit", () => {
    const onChange = jest.fn()
    render(
      <MessageDisplayControls
        allowInherit
        value={undefined}
        inheritedValue={{ preset: "focused", overrides: { layout: "cards" } }}
        onChange={onChange}
      />
    )
    const selects = screen.getAllByRole("combobox")
    expect(selects[0]).toHaveValue("inherit")
    expect(selects[1]).toHaveValue("cards")
    fireEvent.change(selects[2], { target: { value: "all" } })
    expect(onChange).toHaveBeenCalledWith({
      preset: "focused",
      overrides: { actions: "all" },
    })
  })

  it("emits preset and partial advanced overrides", () => {
    const onChange = jest.fn()
    render(<MessageDisplayControls value={{ preset: "balanced" }} onChange={onChange} />)

    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "inspector" } })
    expect(onChange).toHaveBeenCalledWith({ preset: "inspector", overrides: undefined })

    fireEvent.change(selects[1], { target: { value: "cards" } })
    expect(onChange).toHaveBeenCalledWith({
      preset: "balanced",
      overrides: { layout: "cards" },
    })
  })

  it("shows the preset's turn folding and emits an explicit override", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <MessageDisplayControls value={{ preset: "balanced" }} onChange={onChange} />
    )
    const fold = document.getElementById("message-display-fold-completed-turns")!
    expect(fold).toHaveAttribute("data-state", "checked")
    fireEvent.click(fold)
    expect(onChange).toHaveBeenCalledWith({
      preset: "balanced",
      overrides: { foldCompletedTurns: false },
    })

    rerender(<MessageDisplayControls value={{ preset: "inspector" }} onChange={onChange} />)
    expect(document.getElementById("message-display-fold-completed-turns")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
  })

  it("emits action, part, rich-control, motion, metadata, inherit, and reset changes", () => {
    const onChange = jest.fn()
    render(
      <MessageDisplayControls
        allowInherit
        value={{ preset: "balanced", overrides: { layout: "cards" } }}
        onChange={onChange}
      />
    )
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "inherit" } })
    expect(onChange).toHaveBeenCalledWith(undefined)

    const changes: Array<[number, string, string]> = [
      [2, "all", "actions"],
      [3, "detailed", "agentFlowMode"],
      [4, "expanded", "reasoning"],
      [5, "hidden", "tools"],
      [6, "auto", "sources"],
      [7, "always", "richControls"],
      [8, "off", "motion"],
    ]
    for (const [index, value, key] of changes) {
      fireEvent.change(selects[index], { target: { value } })
      expect(onChange).toHaveBeenCalledWith({
        preset: "balanced",
        overrides: { layout: "cards", [key]: value },
      })
    }

    // Selects 9–10 are reading (ADR-0218), 11–13 links (ADR-0218), 14–19 the
    // content-rendering selects (body font, math size, math alignment, code
    // theme, code height, block density); metadata placement starts at 20.
    fireEvent.change(selects[22], { target: { value: "details" } })
    expect(onChange).toHaveBeenCalledWith({
      preset: "balanced",
      overrides: { layout: "cards", metadata: { model: "details" } },
    })
    fireEvent.click(screen.getByRole("button", { name: "resetOverrides" }))
    expect(onChange).toHaveBeenCalledWith({ preset: "balanced" })
  })

  describe("content rendering knobs (ADR-0127)", () => {
    it("emits bodyFont and the math selects as typed override values", () => {
      const onChange = jest.fn()
      render(<MessageDisplayControls value={{ preset: "balanced" }} onChange={onChange} />)
      const selects = within(screen.getByTestId("message-display-markdown")).getAllByRole(
        "combobox"
      )
      // Fallbacks reflect the resolved preset defaults.
      expect(selects[0]).toHaveValue("sans")
      expect(selects[1]).toHaveValue("1")
      expect(selects[2]).toHaveValue("center")

      fireEvent.change(selects[0], { target: { value: "serif" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { bodyFont: "serif" },
      })
      fireEvent.change(selects[1], { target: { value: "1.2" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { mathFontScale: 1.2 } },
      })
      fireEvent.change(selects[2], { target: { value: "left" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { mathAlign: "left" } },
      })
    })

    it("renders one switch per boolean markdown knob and merges toggles into markdown overrides", () => {
      const onChange = jest.fn()
      render(
        <MessageDisplayControls
          value={{ preset: "balanced", overrides: { markdown: { mermaid: false } } }}
          onChange={onChange}
        />
      )
      const group = screen.getByTestId("message-display-markdown")
      const switches = group.querySelectorAll("[role=switch]")
      expect(switches).toHaveLength(9)
      const byId = (id: string) => document.getElementById(`message-display-markdown-${id}`)!
      // ADR-0218 frame chrome: both on by default.
      expect(byId("blockBorder")).toHaveAttribute("data-state", "checked")
      expect(byId("blockHeader")).toHaveAttribute("data-state", "checked")
      // Own override wins over the preset default …
      expect(byId("mermaid")).toHaveAttribute("data-state", "unchecked")
      // … and untouched knobs show the resolved default.
      expect(byId("math")).toHaveAttribute("data-state", "checked")
      expect(byId("codeWrap")).toHaveAttribute("data-state", "unchecked")

      fireEvent.click(byId("codeWrap"))
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { mermaid: false, codeWrap: true } },
      })
      fireEvent.click(byId("math"))
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { mermaid: false, math: false } },
      })
    })
  })
  describe("reading, link and block knobs (ADR-0218)", () => {
    it("emits reading overrides and shows the resolved defaults", () => {
      const onChange = jest.fn()
      render(<MessageDisplayControls value={{ preset: "balanced" }} onChange={onChange} />)
      const [textSize, spacing] = within(
        screen.getByTestId("message-display-reading")
      ).getAllByRole("combobox")
      expect(textSize).toHaveValue("md")
      expect(spacing).toHaveValue("comfortable")
      fireEvent.change(textSize, { target: { value: "lg" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { reading: { textSize: "lg" } },
      })
    })

    it("merges link overrides and toggles the site icon", () => {
      const onChange = jest.fn()
      render(
        <MessageDisplayControls
          value={{ preset: "balanced", overrides: { links: { color: "text" } } }}
          onChange={onChange}
        />
      )
      const group = screen.getByTestId("message-display-links")
      const [color, underline, preview] = within(group).getAllByRole("combobox")
      expect(color).toHaveValue("text")
      expect(underline).toHaveValue("subtle")
      expect(preview).toHaveValue("hover")
      fireEvent.change(preview, { target: { value: "off" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { links: { color: "text", preview: "off" } },
      })
      const siteIcon = document.getElementById("message-display-links-siteIcon")!
      expect(siteIcon).toHaveAttribute("data-state", "checked")
      fireEvent.click(siteIcon)
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { links: { color: "text", siteIcon: false } },
      })
    })

    it("emits code theme, code height, block density and the chart switch", () => {
      const onChange = jest.fn()
      render(<MessageDisplayControls value={{ preset: "balanced" }} onChange={onChange} />)
      const group = screen.getByTestId("message-display-markdown")
      const [, , , codeTheme, codeMaxHeight, blockDensity] = within(group).getAllByRole("combobox")
      expect(codeTheme).toHaveValue("one")
      expect(codeMaxHeight).toHaveValue("tall")
      expect(blockDensity).toHaveValue("compact")
      fireEvent.change(codeTheme, { target: { value: "catppuccin" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { codeTheme: "catppuccin" } },
      })
      fireEvent.change(codeMaxHeight, { target: { value: "none" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { codeMaxHeight: "none" } },
      })
      fireEvent.change(blockDensity, { target: { value: "comfortable" } })
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { blockDensity: "comfortable" } },
      })
      fireEvent.click(document.getElementById("message-display-markdown-charts")!)
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { charts: false } },
      })
      fireEvent.click(document.getElementById("message-display-markdown-blockHeader")!)
      expect(onChange).toHaveBeenLastCalledWith({
        preset: "balanced",
        overrides: { markdown: { blockHeader: false } },
      })
    })
  })
})
