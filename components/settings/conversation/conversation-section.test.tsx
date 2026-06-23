import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom"
import { ConversationSection } from "./conversation-section"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("../chat/composer-assistance-card", () => ({
  ComposerAssistanceCard: () => <div data-testid="composer-assistance-stub" />,
}))

jest.mock("./composer-behavior-card", () => ({
  ComposerBehaviorCard: () => <div data-testid="composer-behavior-stub" />,
}))

jest.mock("./compaction-settings", () => ({
  CompactionSettings: () => <div data-testid="compaction-stub" />,
}))

let mockSettings: Record<string, unknown> | null
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: mockSettings, save: mockSave }),
}))

beforeEach(() => {
  mockSave.mockClear()
  mockSettings = {
    conversationTitle: { enabled: true },
    conversationTimeline: { enabled: true, labelSummary: { enabled: false } },
    providerSettings: { openai: { apiKey: "x" } },
  }
})

afterEach(() => cleanup())

describe("ConversationSection", () => {
  it("shows the title-model fields when auto-title is on", () => {
    render(<ConversationSection />)
    expect(screen.getByText("titleModel.heading")).toBeInTheDocument()
  })

  it("renders the composer-assistance card", () => {
    render(<ConversationSection />)
    expect(screen.getByTestId("composer-assistance-stub")).toBeInTheDocument()
  })

  it("renders the input-&-send card with the behavior card alongside assistance", () => {
    render(<ConversationSection />)
    expect(screen.getByText("inputSend.title")).toBeInTheDocument()
    expect(screen.getByTestId("composer-behavior-stub")).toBeInTheDocument()
  })

  it("renders the standalone message-stream card with the streaming toggle", () => {
    render(<ConversationSection />)
    expect(screen.getByText("messageStream.title")).toBeInTheDocument()
    expect(screen.getByLabelText("streaming.label")).toBeChecked()
  })

  it("toggling token-level streaming persists the change", () => {
    render(<ConversationSection />)
    fireEvent.click(screen.getByLabelText("streaming.label"))
    expect(mockSave).toHaveBeenCalledWith({ streamPartialMessages: false })
  })

  it("hides the title-model fields when auto-title is off", () => {
    mockSettings = {
      conversationTitle: { enabled: false },
      conversationTimeline: { enabled: true },
    }
    render(<ConversationSection />)
    expect(screen.queryByText("titleModel.heading")).not.toBeInTheDocument()
  })

  it("toggling auto-title persists the change", () => {
    render(<ConversationSection />)
    fireEvent.click(screen.getByLabelText("autoTitle.label"))
    expect(mockSave).toHaveBeenCalledWith({
      conversationTitle: expect.objectContaining({ enabled: false }),
    })
  })

  it("shows the label-summary toggle but hides its model fields by default", () => {
    render(<ConversationSection />)
    expect(screen.getByLabelText("labelSummary.label")).toBeInTheDocument()
    expect(screen.queryByText("labelModel.heading")).not.toBeInTheDocument()
  })

  it("enabling label summary reveals its model fields and persists nested config", () => {
    render(<ConversationSection />)
    fireEvent.click(screen.getByLabelText("labelSummary.label"))
    expect(mockSave).toHaveBeenCalledWith({
      conversationTimeline: expect.objectContaining({
        labelSummary: expect.objectContaining({ enabled: true }),
      }),
    })
  })

  it("hides the timeline sub-options when the timeline is disabled", () => {
    mockSettings = {
      conversationTitle: { enabled: true },
      conversationTimeline: { enabled: false },
    }
    render(<ConversationSection />)
    expect(screen.queryByLabelText("labelSummary.label")).not.toBeInTheDocument()
  })
})
