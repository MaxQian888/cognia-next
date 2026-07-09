/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

// The judge model picker reads its options through the provider-routing helper;
// drive it from a mutable holder so one test can exercise the grouped list.
let mockGroups: Array<{ providerId: string; providerName: string; models: string[] }> = []
jest.mock("@cognia/provider-routing/model-option-source", () => ({
  collectOptions: () => [],
  groupByProvider: () => mockGroups,
}))

// cmdk scrolls the active item into view; jsdom lacks the API.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

let mockSettings: Record<string, unknown> | null
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

import { EvalSettingsSection } from "./eval-settings-section"

beforeEach(() => {
  mockSave.mockClear()
  mockSave.mockResolvedValue(undefined)
  push.mockClear()
  mockGroups = []
  mockSettings = { evalSettings: { defaultK: 1, defaultScorerIds: [] } }
})

afterEach(() => cleanup())

describe("EvalSettingsSection", () => {
  it("renders the four cards", () => {
    render(<EvalSettingsSection />)
    expect(screen.getByTestId("eval-settings-section")).toBeInTheDocument()
    expect(screen.getByText("judgeTitle")).toBeInTheDocument()
    expect(screen.getByText("runTitle")).toBeInTheDocument()
    expect(screen.getByText("gateTitle")).toBeInTheDocument()
    expect(screen.getByText("costTitle")).toBeInTheDocument()
  })

  it("toggles deterministic-only through save", async () => {
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByRole("switch"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        evalSettings: expect.objectContaining({ deterministicOnly: true }),
      })
    )
    await screen.findByText("saved") // flush the async save inside act()
  })

  it("persists a changed default k", async () => {
    render(<EvalSettingsSection />)
    fireEvent.change(screen.getByLabelText("defaultKLabel"), { target: { value: "3" } })
    const last = mockSave.mock.calls.at(-1)![0]
    expect(last.evalSettings.defaultK).toBe(3)
    await screen.findByText("saved")
  })

  it("writes a gate threshold and clears it back to no-gate", async () => {
    render(<EvalSettingsSection />)
    const field = screen.getByLabelText("gateMinPassAt1")
    fireEvent.change(field, { target: { value: "0.8" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate).toEqual({ minPassAt1: 0.8 })
    await screen.findByText("saved") // flush the first save before unmounting
    // Re-render with the persisted value, then clear it → gate becomes undefined.
    mockSettings = {
      evalSettings: { defaultK: 1, defaultScorerIds: [], defaultGate: { minPassAt1: 0.8 } },
    }
    cleanup()
    render(<EvalSettingsSection />)
    fireEvent.change(screen.getByLabelText("gateMinPassAt1"), { target: { value: "" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate).toBeUndefined()
    await screen.findByText("saved")
  })

  it("opens the eval workspace", () => {
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByText("openWorkspace"))
    expect(push).toHaveBeenCalledWith("/eval")
  })

  it("explains the coupled disabled state only when deterministic-only is on", () => {
    render(<EvalSettingsSection />)
    expect(screen.queryByText("deterministicActiveHint")).not.toBeInTheDocument()
    cleanup()
    mockSettings = {
      evalSettings: { defaultK: 1, defaultScorerIds: [], deterministicOnly: true },
    }
    render(<EvalSettingsSection />)
    expect(screen.getByText("deterministicActiveHint")).toBeInTheDocument()
  })

  it("flips the gate badge between inactive and active", () => {
    render(<EvalSettingsSection />)
    expect(screen.getByText("gateInactive")).toBeInTheDocument()
    expect(screen.queryByText("gateActive")).not.toBeInTheDocument()
    cleanup()
    mockSettings = {
      evalSettings: { defaultK: 1, defaultScorerIds: [], defaultGate: { minPassAt1: 0.8 } },
    }
    render(<EvalSettingsSection />)
    expect(screen.getByText("gateActive")).toBeInTheDocument()
  })

  it("warns only when min pass^k exceeds min pass@1", () => {
    mockSettings = {
      evalSettings: {
        defaultK: 1,
        defaultScorerIds: [],
        defaultGate: { minPassAt1: 0.9, minPassHatK: 0.5 },
      },
    }
    render(<EvalSettingsSection />)
    expect(screen.queryByText("gateInconsistent")).not.toBeInTheDocument()
    cleanup()
    mockSettings = {
      evalSettings: {
        defaultK: 1,
        defaultScorerIds: [],
        defaultGate: { minPassAt1: 0.5, minPassHatK: 0.9 },
      },
    }
    render(<EvalSettingsSection />)
    expect(screen.getByText("gateInconsistent")).toBeInTheDocument()
  })

  it("flashes a saved status after a change persists", async () => {
    render(<EvalSettingsSection />)
    expect(screen.queryByTestId("eval-save-status")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch"))
    expect(await screen.findByText("saved")).toBeInTheDocument()
  })

  it("clears the save status when persistence fails", async () => {
    mockSave.mockRejectedValueOnce(new Error("disk full"))
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByRole("switch"))
    // The "saving" pill mounts synchronously, then the rejection returns to idle.
    await waitFor(() => expect(screen.queryByTestId("eval-save-status")).not.toBeInTheDocument())
  })

  it("persists every gate and cost threshold", async () => {
    render(<EvalSettingsSection />)
    fireEvent.change(screen.getByLabelText("gateMinPassHatK"), { target: { value: "0.6" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate).toEqual({ minPassHatK: 0.6 })
    fireEvent.change(screen.getByLabelText("gateMinScorerPassRate"), { target: { value: "0.7" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate.minScorerPassRate).toBe(0.7)
    fireEvent.change(screen.getByLabelText("gateMaxCost"), { target: { value: "5" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate.maxTotalCostUsd).toBe(5)
    fireEvent.change(screen.getByLabelText("costWarnLabel"), { target: { value: "2" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.costWarnUsd).toBe(2)
    await screen.findByText("saved")
  })

  it("picks a judge model from the grouped picker", async () => {
    mockGroups = [{ providerId: "anthropic", providerName: "Anthropic", models: ["claude-x"] }]
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByLabelText("judgeModelLabel"))
    fireEvent.click(await screen.findByText("claude-x"))
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.judgeModel).toBe("claude-x")
    await screen.findByText("saved")
  })

  it("resets the judge model back to auto", async () => {
    mockGroups = [{ providerId: "anthropic", providerName: "Anthropic", models: ["claude-x"] }]
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByLabelText("judgeModelLabel"))
    // The trigger label and the "Auto" option share text; the option is the one
    // inside a role="option" element.
    const auto = (await screen.findAllByText("judgeModelAuto")).find((el) =>
      el.closest('[role="option"]')
    )
    fireEvent.click(auto!)
    expect(mockSave.mock.calls.at(-1)![0].evalSettings).toHaveProperty("judgeModel", undefined)
    await screen.findByText("saved")
  })

  it("reflects a persisted judge model and clamps an invalid k", async () => {
    mockGroups = [{ providerId: "anthropic", providerName: "Anthropic", models: ["claude-x"] }]
    mockSettings = {
      evalSettings: {
        defaultK: 2,
        defaultScorerIds: [],
        judgeModel: "claude-x",
        defaultGate: { minScorerPassRate: 0.5 },
      },
    }
    render(<EvalSettingsSection />)
    const trigger = screen.getByLabelText("judgeModelLabel")
    expect(trigger).toHaveTextContent("claude-x") // truthy-value trigger branch
    expect(screen.getByLabelText("gateMinScorerPassRate")).toHaveValue(0.5)
    // Open the picker so the selected-vs-auto opacity branches render.
    fireEvent.click(trigger)
    expect(await screen.findByText("Anthropic")).toBeInTheDocument()
    // A non-numeric k parses to undefined and falls back to the min.
    fireEvent.change(screen.getByLabelText("defaultKLabel"), { target: { value: "abc" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultK).toBe(1)
    await screen.findByText("saved")
  })
})
