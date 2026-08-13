/**
 * @jest-environment jsdom
 */

import * as ReactForMock from "react"
import { fireEvent, render, screen } from "@testing-library/react"

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

    fireEvent.change(selects[11], { target: { value: "details" } })
    expect(onChange).toHaveBeenCalledWith({
      preset: "balanced",
      overrides: { layout: "cards", metadata: { model: "details" } },
    })
    fireEvent.click(screen.getByRole("button", { name: "resetOverrides" }))
    expect(onChange).toHaveBeenCalledWith({ preset: "balanced" })
  })
})
