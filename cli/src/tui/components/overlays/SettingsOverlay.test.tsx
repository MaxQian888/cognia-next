import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { SettingsOverlay } from "./SettingsOverlay"
import type { SettingsSectionView } from "../../runtime/settings-sections"

const sections: SettingsSectionView[] = [
  {
    id: "model",
    title: "Model",
    rows: [
      {
        id: "provider",
        label: "Provider",
        value: "anthropic",
        control: { type: "delegate", command: "/provider" },
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    rows: [
      {
        id: "theme",
        label: "Theme",
        value: "dark",
        control: {
          type: "enum",
          options: ["classic", "dark", "light"],
          current: "dark",
          apply: { kind: "theme" },
        },
      },
      {
        id: "mascot",
        label: "Mascot",
        value: "on",
        control: { type: "boolean", current: true, apply: { kind: "mascotEnabled" } },
      },
    ],
  },
]

function setup(over: Partial<React.ComponentProps<typeof SettingsOverlay>> = {}) {
  const props = {
    sections,
    section: 0,
    index: 0,
    onMoveRow: jest.fn(),
    onSwitchSection: jest.fn(),
    onAdjust: jest.fn(),
    onToggle: jest.fn(),
    onActivate: jest.fn(),
    onClose: jest.fn(),
    ...over,
  }
  const r = render(<SettingsOverlay {...props} />)
  return { ...props, ...r }
}

describe("SettingsOverlay", () => {
  beforeEach(() => __resetInk())

  it("renders the section tabs, highlighting the active one", () => {
    const { container } = setup({ section: 1 })
    const text = container.textContent ?? ""
    expect(text).toContain("Settings")
    expect(text).toContain("[Appearance]")
    expect(text).toContain("Model")
  })

  it("renders the active section's rows with their values", () => {
    const { container } = setup({ section: 1, index: 0 })
    const text = container.textContent ?? ""
    expect(text).toContain("Theme")
    expect(text).toContain("‹ dark ›") // enum value chrome
    expect(text).toContain("[x]") // boolean on
  })

  it("Tab switches section forward, Shift+Tab backward", () => {
    const { onSwitchSection } = setup()
    __fireInput("", { tab: true })
    __fireInput("", { tab: true, shift: true })
    expect(onSwitchSection).toHaveBeenNthCalledWith(1, 1)
    expect(onSwitchSection).toHaveBeenNthCalledWith(2, -1)
  })

  it("↑/↓ move the focused row", () => {
    const { onMoveRow } = setup({ section: 1 })
    __fireInput("", { downArrow: true })
    __fireInput("", { upArrow: true })
    expect(onMoveRow).toHaveBeenNthCalledWith(1, 1)
    expect(onMoveRow).toHaveBeenNthCalledWith(2, -1)
  })

  it("←/→ adjusts an enum row instead of switching section", () => {
    const { onAdjust, onSwitchSection } = setup({ section: 1, index: 0 })
    __fireInput("", { rightArrow: true })
    __fireInput("", { leftArrow: true })
    expect(onAdjust).toHaveBeenNthCalledWith(1, sections[1].rows[0], 1)
    expect(onAdjust).toHaveBeenNthCalledWith(2, sections[1].rows[0], -1)
    expect(onSwitchSection).not.toHaveBeenCalled()
  })

  it("←/→ switches section when the focused row is not an enum", () => {
    const { onSwitchSection } = setup({ section: 0, index: 0 }) // delegate row
    __fireInput("", { rightArrow: true })
    expect(onSwitchSection).toHaveBeenCalledWith(1)
  })

  it("Space toggles a boolean row", () => {
    const { onToggle } = setup({ section: 1, index: 1 })
    __fireInput(" ", {})
    expect(onToggle).toHaveBeenCalledWith(sections[1].rows[1])
  })

  it("Enter activates a delegate row", () => {
    const { onActivate } = setup({ section: 0, index: 0 })
    __fireInput("", { return: true })
    expect(onActivate).toHaveBeenCalledWith(sections[0].rows[0])
  })

  it("Enter cycles an enum row forward", () => {
    const { onAdjust } = setup({ section: 1, index: 0 })
    __fireInput("", { return: true })
    expect(onAdjust).toHaveBeenCalledWith(sections[1].rows[0], 1)
  })

  it("Esc closes the panel", () => {
    const { onClose } = setup()
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })
})
