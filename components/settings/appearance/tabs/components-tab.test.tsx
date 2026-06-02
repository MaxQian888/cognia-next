/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"
import type { ComponentStyles } from "@/types/appearance"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { ComponentsTab } from "./components-tab"

function rowFor(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector(`[data-component-key="${key}"]`)
  if (!row) throw new Error(`row ${key} not found`)
  return row as HTMLElement
}

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
})

describe("ComponentsTab", () => {
  it("renders every group and a row per registered component", () => {
    const { container } = render(<ComponentsTab />)
    expect(screen.getByText("groups.surfaces")).toBeInTheDocument()
    expect(screen.getByText("groups.overlays")).toBeInTheDocument()
    expect(screen.getByText("groups.modals")).toBeInTheDocument()
    expect(screen.getByText("groups.chat")).toBeInTheDocument()
    // A few representative rows across the groups, incl. the ai-elements chat group.
    expect(rowFor(container, "card")).toBeInTheDocument()
    expect(rowFor(container, "popover")).toBeInTheDocument()
    expect(rowFor(container, "dialog")).toBeInTheDocument()
    expect(rowFor(container, "aiTool")).toBeInTheDocument()
    expect(rowFor(container, "aiTerminal")).toBeInTheDocument()
  })

  it("setting a chat-surface tonality saves under its key (aiTool)", () => {
    const { container } = render(<ComponentsTab />)
    const tool = rowFor(container, "aiTool")
    const tonalityTrigger = within(tool).getAllByRole("combobox")[0]
    fireEvent.click(tonalityTrigger)
    fireEvent.click(screen.getByRole("option", { name: "tonality.translucent" }))
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.aiTool?.tonality).toBe("translucent")
  })

  it("setting Card tonality saves componentStyles.card.tonality", () => {
    const { container } = render(<ComponentsTab />)
    const card = rowFor(container, "card")
    // First combobox in the row is the tonality axis.
    const tonalityTrigger = within(card).getAllByRole("combobox")[0]
    fireEvent.click(tonalityTrigger)
    fireEvent.click(screen.getByRole("option", { name: "tonality.glass" }))
    expect(save).toHaveBeenCalled()
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.card?.tonality).toBe("glass")
  })

  it("returning an axis to default drops the override so no empty record lingers", () => {
    storeState.settings = { componentStyles: { card: { tonality: "glass" } } }
    const { container } = render(<ComponentsTab />)
    const card = rowFor(container, "card")
    const tonalityTrigger = within(card).getAllByRole("combobox")[0]
    fireEvent.click(tonalityTrigger)
    fireEvent.click(screen.getByRole("option", { name: "tonality.default" }))
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.card).toBeUndefined()
  })

  it("setting Card elevation saves componentStyles.card.elevation", () => {
    const { container } = render(<ComponentsTab />)
    const card = rowFor(container, "card")
    // Second combobox in the row is the elevation axis.
    const elevationTrigger = within(card).getAllByRole("combobox")[1]
    fireEvent.click(elevationTrigger)
    fireEvent.click(screen.getByRole("option", { name: "2" }))
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.card?.elevation).toBe("2")
  })

  it("setting Card radius saves a numeric radiusScale, and inherit drops it", () => {
    storeState.settings = { componentStyles: { card: { radiusScale: 1.5 } } }
    const { container } = render(<ComponentsTab />)
    const card = rowFor(container, "card")
    // Third combobox in the row is the radius axis.
    const radiusTrigger = within(card).getAllByRole("combobox")[2]
    fireEvent.click(radiusTrigger)
    fireEvent.click(screen.getByRole("option", { name: "radius.inherit" }))
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.card).toBeUndefined()
  })

  it("applies a non-default radius multiplier", () => {
    const { container } = render(<ComponentsTab />)
    const card = rowFor(container, "card")
    const radiusTrigger = within(card).getAllByRole("combobox")[2]
    fireEvent.click(radiusTrigger)
    fireEvent.click(screen.getByRole("option", { name: "1.5×" }))
    const patch = save.mock.calls[0][0] as { componentStyles: ComponentStyles }
    expect(patch.componentStyles.card?.radiusScale).toBe(1.5)
  })

  it("Reset all is disabled with no overrides and clears componentStyles when used", () => {
    storeState.settings = { componentStyles: { card: { elevation: "2" } } }
    render(<ComponentsTab />)
    const reset = screen.getByRole("button", { name: "resetAll" })
    expect(reset).not.toBeDisabled()
    fireEvent.click(reset)
    expect(save).toHaveBeenCalledWith({ componentStyles: {} })
  })

  it("disables Reset all when nothing is customized", () => {
    storeState.settings = { componentStyles: {} }
    render(<ComponentsTab />)
    expect(screen.getByRole("button", { name: "resetAll" })).toBeDisabled()
  })
})
