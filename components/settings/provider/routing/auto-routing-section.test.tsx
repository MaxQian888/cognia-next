/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async () => undefined)
let settingsState: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings: settingsState, save: saveMock }),
}))

import { AutoRoutingSection } from "./auto-routing-section"

beforeEach(() => {
  saveMock.mockClear()
  settingsState = {}
})

describe("AutoRoutingSection", () => {
  it("renders default OFF and toggles enabled via a save patch", () => {
    render(<AutoRoutingSection />)
    const toggle = screen.getByRole("switch", { name: "enabled" })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        enabled: true,
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
    })
  })

  it("persists in-range thresholds and ignores out-of-range values", () => {
    settingsState = {
      autoRouting: {
        enabled: true,
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      },
    }
    render(<AutoRoutingSection />)
    fireEvent.change(screen.getByLabelText("thresholdBalanced"), { target: { value: "0.4" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ thresholds: { balanced: 0.4, powerful: 0.67 } }),
    })
    fireEvent.change(screen.getByLabelText("thresholdPowerful"), { target: { value: "0.8" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ thresholds: { balanced: 0.34, powerful: 0.8 } }),
    })
    // Out-of-range is dropped.
    saveMock.mockClear()
    fireEvent.change(screen.getByLabelText("thresholdPowerful"), { target: { value: "5" } })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("disables the threshold inputs when auto routing is off", () => {
    render(<AutoRoutingSection />)
    expect(screen.getByLabelText("thresholdBalanced")).toBeDisabled()
    expect(screen.getByLabelText("thresholdPowerful")).toBeDisabled()
  })
})
