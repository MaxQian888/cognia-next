/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  CompanionFusionModePicker,
  isCompanionComposerMode,
  COMPANION_COMPOSER_MODES,
} from "./companion-fusion-mode-picker"

describe("CompanionFusionModePicker", () => {
  it("offers Direct, Cascade and Panel — no Auto, which a phone has no router for", async () => {
    const user = userEvent.setup()
    const onModeChange = jest.fn()
    render(<CompanionFusionModePicker mode="direct" onModeChange={onModeChange} />)
    const trigger = screen.getByTestId("companion-fusion-mode")
    expect(trigger).toHaveAttribute("data-mode", "direct")
    expect(trigger).toHaveAccessibleName("How this message runs: Direct")
    // The default reads as a glyph; only a fusion mode spends label room.
    expect(trigger).not.toHaveTextContent("Direct")

    await user.click(trigger)
    const menu = await screen.findByTestId("companion-fusion-mode-menu")
    expect(menu).toHaveTextContent("Sent to the host as an ordinary message.")
    expect(menu).toHaveTextContent("Runs on the host with its own budget and caps.")
    expect(screen.queryByTestId("companion-fusion-mode-auto")).toBeNull()
    await user.click(screen.getByTestId("companion-fusion-mode-panel"))
    expect(onModeChange).toHaveBeenCalledWith("panel")
  })

  it("labels a fusion mode on the trigger", () => {
    render(<CompanionFusionModePicker mode="cascade" onModeChange={jest.fn()} />)
    const trigger = screen.getByTestId("companion-fusion-mode")
    expect(trigger).toHaveTextContent("Cascade")
    expect(trigger).toHaveAccessibleName("How this message runs: Cascade")
  })

  it("can be disabled while a send is in flight", () => {
    render(<CompanionFusionModePicker mode="direct" onModeChange={jest.fn()} disabled />)
    expect(screen.getByTestId("companion-fusion-mode")).toBeDisabled()
  })

  it("knows its own modes", () => {
    expect(COMPANION_COMPOSER_MODES).toEqual(["direct", "cascade", "panel"])
    expect(isCompanionComposerMode("panel")).toBe(true)
    expect(isCompanionComposerMode("auto")).toBe(false)
  })
})
