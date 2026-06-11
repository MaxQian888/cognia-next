import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import { CompactionSettings } from "./compaction-settings"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockSettings: Record<string, unknown> | null
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

const mockEntries = jest.fn(() => [] as Array<{ id: string; entry: { label?: string } }>)
jest.mock("@/lib/plugin/registries/compaction-strategy-registry", () => ({
  listCompactionStrategyEntries: () => mockEntries(),
}))

beforeEach(() => {
  mockSave.mockClear()
  mockEntries.mockReturnValue([])
  mockSettings = {}
})

afterEach(() => cleanup())

describe("CompactionSettings", () => {
  it("defaults to enabled and shows the threshold + keep-recent + focus controls", () => {
    render(<CompactionSettings />)
    expect(screen.getByLabelText("enabled.label")).toBeChecked()
    expect(screen.getByLabelText("threshold.label")).toBeInTheDocument()
    expect(screen.getByLabelText("keepRecent.label")).toBeInTheDocument()
    expect(screen.getByLabelText("focus.label")).toBeInTheDocument()
  })

  it("toggling auto-compaction off persists enabled:false and hides the controls", () => {
    render(<CompactionSettings />)
    fireEvent.click(screen.getByLabelText("enabled.label"))
    expect(mockSave).toHaveBeenCalledWith({ compaction: { enabled: false } })
  })

  it("hides the threshold/focus controls when compaction is disabled", () => {
    mockSettings = { compaction: { enabled: false } }
    render(<CompactionSettings />)
    expect(screen.queryByLabelText("threshold.label")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("focus.label")).not.toBeInTheDocument()
  })

  it("persists a changed trigger threshold", () => {
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("threshold.label"), { target: { value: "70" } })
    expect(mockSave).toHaveBeenCalledWith({ compaction: { tokenThreshold: 70 } })
  })

  it("ignores an out-of-range threshold", () => {
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("threshold.label"), { target: { value: "5" } })
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("persists a changed keep-recent count", () => {
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("keepRecent.label"), { target: { value: "12" } })
    expect(mockSave).toHaveBeenCalledWith({ compaction: { preserveRecentMessages: 12 } })
  })

  it("persists the compact-instructions focus", () => {
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("focus.label"), {
      target: { value: "the API changes" },
    })
    expect(mockSave).toHaveBeenCalledWith({ compaction: { focus: "the API changes" } })
  })

  it("shows the strategy picker only when plugin strategies are registered", () => {
    const { rerender } = render(<CompactionSettings />)
    expect(screen.queryByLabelText("strategy.label")).not.toBeInTheDocument()
    mockEntries.mockReturnValue([{ id: "p:keyfacts", entry: { label: "Key facts" } }])
    rerender(<CompactionSettings />)
    expect(screen.getByLabelText("strategy.label")).toBeInTheDocument()
  })
})
