/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

// The judge model picker only needs the provider grouping to render an empty
// list here; stub it so the section doesn't depend on real provider config.
jest.mock("@cognia/provider-routing/model-option-source", () => ({
  collectOptions: () => [],
  groupByProvider: () => [],
}))

let mockSettings: Record<string, unknown> | null
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

import { EvalSettingsSection } from "./eval-settings-section"

beforeEach(() => {
  mockSave.mockClear()
  push.mockClear()
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

  it("toggles deterministic-only through save", () => {
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByRole("switch"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        evalSettings: expect.objectContaining({ deterministicOnly: true }),
      })
    )
  })

  it("persists a changed default k", () => {
    render(<EvalSettingsSection />)
    fireEvent.change(screen.getByLabelText("defaultKLabel"), { target: { value: "3" } })
    const last = mockSave.mock.calls.at(-1)![0]
    expect(last.evalSettings.defaultK).toBe(3)
  })

  it("writes a gate threshold and clears it back to no-gate", () => {
    render(<EvalSettingsSection />)
    const field = screen.getByLabelText("gateMinPassAt1")
    fireEvent.change(field, { target: { value: "0.8" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate).toEqual({ minPassAt1: 0.8 })
    // Re-render with the persisted value, then clear it → gate becomes undefined.
    mockSettings = {
      evalSettings: { defaultK: 1, defaultScorerIds: [], defaultGate: { minPassAt1: 0.8 } },
    }
    cleanup()
    render(<EvalSettingsSection />)
    fireEvent.change(screen.getByLabelText("gateMinPassAt1"), { target: { value: "" } })
    expect(mockSave.mock.calls.at(-1)![0].evalSettings.defaultGate).toBeUndefined()
  })

  it("opens the eval workspace", () => {
    render(<EvalSettingsSection />)
    fireEvent.click(screen.getByText("openWorkspace"))
    expect(push).toHaveBeenCalledWith("/eval")
  })
})
