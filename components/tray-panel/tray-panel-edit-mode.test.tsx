import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceLayoutEntry, GlancePanelSettings } from "@/types/glance/layout"

import { TrayPanelEditMode } from "./tray-panel-edit-mode"

function setup(patch: Partial<GlancePanelSettings> = {}) {
  const props = {
    onEntries: jest.fn(),
    onDelegateVisible: jest.fn(),
    onWidth: jest.fn(),
  }
  const config: GlancePanelSettings = { ...DEFAULT_GLANCE_PANEL_SETTINGS, ...patch }
  render(<TrayPanelEditMode config={config} {...props} />)
  return { ...props, config }
}

describe("TrayPanelEditMode", () => {
  it("shows the hint and the layout editor with the desktop modules, quick included", () => {
    setup()
    expect(
      screen.getByText(
        "Drag modules to reorder, pick a size, or hide them. Changes apply right away."
      )
    ).toBeInTheDocument()
    const editor = screen.getByTestId("glance-layout-editor")
    // Balanced shows quick; the desktop surface offers it.
    expect(within(editor).getByTestId("glance-editor-row-quick")).toBeInTheDocument()
    expect(within(editor).getByTestId("glance-editor-row-fleet")).toBeInTheDocument()
    // Compact density: short size labels.
    expect(
      within(within(editor).getByTestId("glance-editor-row-fleet")).getByRole("radio", {
        name: "Standard",
      })
    ).toHaveTextContent("M")
  })

  it("offers a hidden quick module for adding", () => {
    setup({
      entries: DEFAULT_GLANCE_PANEL_SETTINGS.entries.map((e) =>
        e.id === "quick" ? { ...e, hidden: true } : e
      ),
    })
    expect(screen.getByRole("button", { name: "Add Quick actions" })).toBeInTheDocument()
  })

  it("forwards layout edits through onEntries", async () => {
    const user = userEvent.setup()
    const { onEntries } = setup()
    await user.click(screen.getByRole("button", { name: "Hide Usage" }))
    expect(onEntries).toHaveBeenCalledTimes(1)
    const next = onEntries.mock.calls[0][0] as GlanceLayoutEntry[]
    expect(next.find((e) => e.id === "usage")?.hidden).toBe(true)
  })

  describe("delegate switch", () => {
    it("reflects showDelegate on", () => {
      setup({ showDelegate: true })
      expect(screen.getByRole("switch", { name: "Delegate bar" })).toBeChecked()
    })

    it("reflects showDelegate off", () => {
      setup({ showDelegate: false })
      expect(screen.getByRole("switch", { name: "Delegate bar" })).not.toBeChecked()
    })

    it("reports the new visibility when toggled", async () => {
      const user = userEvent.setup()
      const { onDelegateVisible } = setup({ showDelegate: true })
      await user.click(screen.getByRole("switch", { name: "Delegate bar" }))
      expect(onDelegateVisible).toHaveBeenCalledWith(false)
    })

    it("reports true when turned back on", async () => {
      const user = userEvent.setup()
      const { onDelegateVisible } = setup({ showDelegate: false })
      await user.click(screen.getByRole("switch", { name: "Delegate bar" }))
      expect(onDelegateVisible).toHaveBeenCalledWith(true)
    })
  })

  describe("width", () => {
    it("offers the three widths, short-labelled and named with their pixel size", () => {
      setup({ width: "standard" })
      const group = screen.getByRole("radiogroup", { name: "Width" })
      const narrow = within(group).getByRole("radio", { name: "Narrow (320 px)" })
      const standard = within(group).getByRole("radio", { name: "Standard (380 px)" })
      const wide = within(group).getByRole("radio", { name: "Wide (460 px)" })
      expect(narrow).toHaveTextContent("S")
      expect(standard).toHaveTextContent("M")
      expect(wide).toHaveTextContent("L")
      expect(standard).toBeChecked()
      expect(narrow).not.toBeChecked()
      expect(wide).not.toBeChecked()
    })

    it("is labelled by the Width caption", () => {
      setup()
      expect(screen.getByRole("radiogroup", { name: "Width" })).toBeInTheDocument()
    })

    it("reports a different width", async () => {
      const user = userEvent.setup()
      const { onWidth } = setup({ width: "standard" })
      await user.click(screen.getByRole("radio", { name: "Wide (460 px)" }))
      expect(onWidth).toHaveBeenCalledTimes(1)
      expect(onWidth).toHaveBeenCalledWith("wide")
    })

    it("reports nothing when the current width is pressed again", async () => {
      const user = userEvent.setup()
      const { onWidth } = setup({ width: "narrow" })
      await user.click(screen.getByRole("radio", { name: "Narrow (320 px)" }))
      expect(onWidth).not.toHaveBeenCalled()
    })
  })
})
