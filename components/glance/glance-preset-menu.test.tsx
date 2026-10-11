import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GLANCE_PRESET_IDS } from "@/types/glance/layout"

import { GlancePresetMenu } from "./glance-preset-menu"

const NAMES = ["Balanced", "Usage first", "Agent ops", "Minimal"]

describe("GlancePresetMenu", () => {
  it("shows the preset name on the trigger and names it for assistive tech", () => {
    render(<GlancePresetMenu preset="usage-first" onApply={jest.fn()} />)
    const trigger = screen.getByRole("button", { name: "Preset: Usage first" })
    expect(trigger).toHaveTextContent("Usage first")
  })

  it("shows Custom once the layout has been edited", () => {
    render(<GlancePresetMenu preset="custom" onApply={jest.fn()} />)
    const trigger = screen.getByRole("button", { name: "Preset: Custom" })
    expect(trigger).toHaveTextContent("Custom")
  })

  it("lists the four presets with a check on the current one", async () => {
    const user = userEvent.setup()
    render(<GlancePresetMenu preset="agent-ops" onApply={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "Preset: Agent ops" }))

    expect(GLANCE_PRESET_IDS).toHaveLength(4)
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((el) => el.textContent)).toEqual(NAMES)
    const checked = items.filter((el) => !el.querySelector("svg")?.classList.contains("invisible"))
    expect(checked).toHaveLength(1)
    expect(checked[0]).toHaveTextContent("Agent ops")
    expect(screen.getByText("Presets")).toBeInTheDocument()
    expect(screen.getByText(/A preset replaces the modules/)).toBeInTheDocument()
  })

  it("checks no preset while the layout is custom", async () => {
    const user = userEvent.setup()
    render(<GlancePresetMenu preset="custom" onApply={jest.fn()} />)
    await user.click(screen.getByRole("button", { name: "Preset: Custom" }))
    const items = await screen.findAllByRole("menuitem")
    for (const item of items) {
      expect(item.querySelector("svg")).toHaveClass("invisible")
    }
  })

  it("applies the chosen preset by id and closes the menu", async () => {
    const user = userEvent.setup()
    const onApply = jest.fn()
    render(<GlancePresetMenu preset="balanced" onApply={onApply} />)
    await user.click(screen.getByRole("button", { name: "Preset: Balanced" }))
    await user.click(await screen.findByRole("menuitem", { name: "Usage first" }))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith("usage-first")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("applies the current preset again (a reset) when it is chosen", async () => {
    const user = userEvent.setup()
    const onApply = jest.fn()
    render(<GlancePresetMenu preset="minimal" onApply={onApply} />)
    await user.click(screen.getByRole("button", { name: "Preset: Minimal" }))
    const menu = await screen.findByRole("menu")
    await user.click(within(menu).getByRole("menuitem", { name: "Minimal" }))
    expect(onApply).toHaveBeenCalledWith("minimal")
  })

  it("disables the trigger when disabled", async () => {
    const user = userEvent.setup()
    render(<GlancePresetMenu preset="balanced" onApply={jest.fn()} disabled />)
    const trigger = screen.getByRole("button", { name: "Preset: Balanced" })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("passes className to the trigger", () => {
    render(<GlancePresetMenu preset="balanced" onApply={jest.fn()} className="custom-cls" />)
    expect(screen.getByRole("button", { name: "Preset: Balanced" })).toHaveClass("custom-cls")
  })
})
