/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

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

import { DensityCard } from "./density-card"

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
})

describe("DensityCard", () => {
  it("renders global + 3 surface overrides", () => {
    render(<DensityCard />)
    expect(screen.getByText("density.globalLabel")).toBeInTheDocument()
    expect(screen.getByText("density.surface.chat")).toBeInTheDocument()
    expect(screen.getByText("density.surface.table")).toBeInTheDocument()
    expect(screen.getByText("density.surface.sidebar")).toBeInTheDocument()
  })

  it("save is wired — flipping a surface override produces a density patch", () => {
    storeState.settings = { density: { global: "comfortable", chat: "compact" } }
    render(<DensityCard />)
    // Switch the chat override back to "inherit" by clicking the Select trigger
    // for the chat surface; we verify the resulting save patch removes the key.
    const chatLabel = screen.getByText("density.surface.chat")
    const trigger = within(chatLabel.parentElement as HTMLElement).getByRole("combobox")
    fireEvent.click(trigger)
    // The combobox is open; the inherit option carries role="option".
    const inheritOption = screen.getByRole("option", { name: "density.inherit" })
    fireEvent.click(inheritOption)
    expect(save).toHaveBeenCalled()
    const patch = save.mock.calls[0][0] as { density: { chat?: string } }
    expect(patch.density.chat).toBeUndefined()
  })
})
