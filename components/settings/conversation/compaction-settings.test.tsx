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

let mockProtocol: string | undefined = "openai"
jest.mock("@cognia/provider-types/built-in-provider-catalog", () => ({
  getBuiltInProviderProtocol: () => mockProtocol,
}))

const mockEntries = jest.fn(() => [] as Array<{ id: string; entry: { label?: string } }>)
jest.mock("@/lib/plugin/registries/compaction-strategy-registry", () => ({
  listCompactionStrategyEntries: () => mockEntries(),
}))

// Mock the Radix Select as a native <select> so onValueChange is testable. The
// aria-label rides on SelectTrigger; options come from SelectItem descendants.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], label: { current?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["aria-label"]) label.current = child.props["aria-label"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, label)
      }
    )
  }
  const Select = ({ value, onValueChange, disabled, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const label: { current?: string } = {}
    collect(children, items as unknown[], label)
    return React.createElement(
      "select",
      {
        "aria-label": label.current,
        value,
        disabled,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.children
        )
      )
    )
  }
  const SelectTrigger = () => null
  const SelectValue = () => null
  const SelectContent = ({ children }: { children: unknown }) => children
  const SelectItem = (props: unknown) => props
  ;(SelectItem as { __isItem?: boolean }).__isItem = true
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

beforeEach(() => {
  mockSave.mockClear()
  mockEntries.mockReturnValue([])
  mockProtocol = "openai"
  // A non-Anthropic default provider so the generic controls are enabled.
  mockSettings = { defaultProvider: "openai" }
})

afterEach(() => cleanup())

describe("CompactionSettings", () => {
  it("defaults to enabled and shows the core controls", () => {
    render(<CompactionSettings />)
    expect(screen.getByLabelText("enabled.label")).toBeChecked()
    expect(screen.getByLabelText("threshold.label")).toBeInTheDocument()
    expect(screen.getByLabelText("keepRecent.label")).toBeInTheDocument()
    expect(screen.getByLabelText("focus.label")).toBeInTheDocument()
    expect(screen.getByLabelText("algorithm.label")).toBeInTheDocument()
    expect(screen.getByLabelText("notify.label")).toBeInTheDocument()
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

  it("persists the enableUndo and notification toggles", () => {
    render(<CompactionSettings />)
    fireEvent.click(screen.getByLabelText("enableUndo.label"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ enableUndo: false }) })
    )
    fireEvent.click(screen.getByLabelText("notify.label"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: expect.objectContaining({ showCompressionNotification: false }),
      })
    )
  })

  it("shows the message-count input only under the message-count trigger", () => {
    mockSettings = { defaultProvider: "openai", compaction: { trigger: "message-count" } }
    render(<CompactionSettings />)
    expect(screen.getByLabelText("messageCount.label")).toBeInTheDocument()
    expect(screen.queryByLabelText("threshold.label")).not.toBeInTheDocument()
  })

  it("shows the importance input only for the selective strategy", () => {
    mockSettings = { defaultProvider: "openai", compaction: { strategy: "selective" } }
    render(<CompactionSettings />)
    expect(screen.getByLabelText("importance.label")).toBeInTheDocument()
  })

  it("persists the retained, tool-result cap and message-count number rows", () => {
    mockSettings = { defaultProvider: "openai", compaction: { trigger: "message-count" } }
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("retained.label"), { target: { value: "30" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ retainedThreshold: 30 }) })
    )
    fireEvent.change(screen.getByLabelText("toolResultCap.label"), { target: { value: "800" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ maxToolResultTokens: 800 }) })
    )
    fireEvent.change(screen.getByLabelText("messageCount.label"), { target: { value: "40" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: expect.objectContaining({ messageCountThreshold: 40 }),
      })
    )
  })

  it("converts the importance percentage to a fraction", () => {
    mockSettings = { defaultProvider: "openai", compaction: { strategy: "selective" } }
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("importance.label"), { target: { value: "60" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ importanceThreshold: 0.6 }) })
    )
  })

  it("persists the recursive chunk size for the recursive strategy", () => {
    mockSettings = { defaultProvider: "openai", compaction: { strategy: "recursive" } }
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("recursiveChunkSize.label"), { target: { value: "30" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ recursiveChunkSize: 30 }) })
    )
  })

  it("persists the preserve-tool / preserve-system / AI-summarisation toggles", () => {
    render(<CompactionSettings />)
    fireEvent.click(screen.getByLabelText("preserveToolMeta.label"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: expect.objectContaining({ preserveToolCallMetadata: false }),
      })
    )
    fireEvent.click(screen.getByLabelText("preserveSystem.label"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: expect.objectContaining({ preserveSystemMessages: false }),
      })
    )
    fireEvent.click(screen.getByLabelText("useAISummarization.label"))
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: expect.objectContaining({ useAISummarization: false }),
      })
    )
  })

  it("shows the strategy picker only when plugin strategies are registered", () => {
    const { rerender } = render(<CompactionSettings />)
    expect(screen.queryByLabelText("strategy.label")).not.toBeInTheDocument()
    mockEntries.mockReturnValue([{ id: "p:keyfacts", entry: { label: "Key facts" } }])
    rerender(<CompactionSettings />)
    expect(screen.getByLabelText("strategy.label")).toBeInTheDocument()
  })

  it("persists method and trigger selections", () => {
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("algorithm.label"), { target: { value: "recursive" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ strategy: "recursive" }) })
    )
    fireEvent.change(screen.getByLabelText("trigger.label"), { target: { value: "message-count" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ trigger: "message-count" }) })
    )
  })

  it("maps the built-in plugin-strategy option back to undefined", () => {
    mockEntries.mockReturnValue([{ id: "p:keyfacts", entry: { label: "Key facts" } }])
    render(<CompactionSettings />)
    fireEvent.change(screen.getByLabelText("strategy.label"), { target: { value: "p:keyfacts" } })
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ compaction: expect.objectContaining({ strategyId: "p:keyfacts" }) })
    )
  })

  describe("Anthropic-path honesty", () => {
    it("disables the generic controls and shows the notice for an Anthropic default", () => {
      mockProtocol = "anthropic"
      mockSettings = { defaultProvider: "anthropic" }
      render(<CompactionSettings />)
      expect(screen.getByTestId("compaction-anthropic-notice")).toBeInTheDocument()
      expect(screen.getByLabelText("threshold.label")).toBeDisabled()
      expect(screen.getByLabelText("keepRecent.label")).toBeDisabled()
      expect(screen.getByLabelText("algorithm.label")).toBeDisabled()
      // focus + notifications stay active on the Anthropic path.
      expect(screen.getByLabelText("focus.label")).not.toBeDisabled()
      expect(screen.getByLabelText("notify.label")).not.toBeDisabled()
    })

    it("enables everything and hides the notice for a non-Anthropic default", () => {
      render(<CompactionSettings />)
      expect(screen.queryByTestId("compaction-anthropic-notice")).not.toBeInTheDocument()
      expect(screen.getByLabelText("threshold.label")).not.toBeDisabled()
    })
  })
})
