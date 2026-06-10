/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentNestingCard } from "./subagent-nesting-card"

const save = jest.fn().mockResolvedValue(undefined)
let mockSettings: { subagentNesting?: unknown } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/logging", () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {}
})

describe("SubagentNestingCard", () => {
  it("defaults to disabled with the depth input disabled", () => {
    render(<SubagentNestingCard />)
    expect(screen.getByRole("switch", { name: "enabled" })).not.toBeChecked()
    expect(screen.getByLabelText("maxDepth")).toBeDisabled()
  })

  it("hydrates from existing settings", () => {
    mockSettings = {
      subagentNesting: { enabled: true, maxDepth: 3, tokenBudget: 5000, timeoutMs: 60000 },
    }
    render(<SubagentNestingCard />)
    expect(screen.getByRole("switch", { name: "enabled" })).toBeChecked()
    expect(screen.getByLabelText("maxDepth")).toHaveValue(3)
    expect(screen.getByLabelText("timeout")).toHaveValue(60) // ms → seconds
  })

  it("saves the config (seconds converted to ms) when enabled", () => {
    render(<SubagentNestingCard />)
    fireEvent.click(screen.getByRole("switch", { name: "enabled" }))
    fireEvent.change(screen.getByLabelText("maxDepth"), { target: { value: "3" } })
    fireEvent.change(screen.getByLabelText("timeout"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith({
      subagentNesting: { enabled: true, maxDepth: 3, tokenBudget: 0, timeoutMs: 30000 },
    })
  })

  it("clamps maxDepth to the 1–5 range", () => {
    render(<SubagentNestingCard />)
    fireEvent.click(screen.getByRole("switch", { name: "enabled" }))
    fireEvent.change(screen.getByLabelText("maxDepth"), { target: { value: "9" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ subagentNesting: expect.objectContaining({ maxDepth: 5 }) })
    )
  })
})
