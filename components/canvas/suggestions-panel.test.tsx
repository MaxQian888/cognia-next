/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SuggestionsPanel } from "./suggestions-panel"

// Mock stores
const mockApplySuggestion = jest.fn()
const mockUpdateSuggestionStatus = jest.fn()
const mockProposeCanvasReview = jest.fn()
jest.mock("@/stores", () => ({
  useArtifactStore: jest.fn((selector) =>
    selector({
      applySuggestion: mockApplySuggestion,
      updateSuggestionStatus: mockUpdateSuggestionStatus,
      proposeCanvasReview: mockProposeCanvasReview,
      canvasDocuments: {
        "doc-1": { id: "doc-1", content: "line 0\nconst x = 1;\nline 2" },
      },
    })
  ),
}))

// Mock UI components
jest.mock("@/components/ui/scroll-area")

jest.mock("./suggestion-item", () => ({
  SuggestionItem: ({
    suggestion,
    onApply,
    onReject,
  }: {
    suggestion: { id: string; explanation: string }
    onApply: (id: string) => void
    onReject: (id: string) => void
  }) => (
    <div data-testid={`suggestion-${suggestion.id}`}>
      <span>{suggestion.explanation}</span>
      <button onClick={() => onApply(suggestion.id)}>Apply</button>
      <button onClick={() => onReject(suggestion.id)}>Reject</button>
    </div>
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      generatingSuggestions: "Generating suggestions...",
      aiSuggestions: "AI Suggestions",
    }
    return translations[key] || key
  },
}))

jest.mock("lucide-react", () => ({
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="loader" className={className}>
      Loading
    </span>
  ),
}))

const mockSuggestions = [
  {
    id: "sugg-1",
    type: "improve" as const,
    explanation: "Improve variable naming",
    originalText: "const x = 1;",
    suggestedText: "const count = 1;",
    range: { startLine: 1, endLine: 1 },
    status: "pending" as const,
  },
  {
    id: "sugg-2",
    type: "fix" as const,
    explanation: "Fix off-by-one error",
    originalText: "i < arr.length - 1",
    suggestedText: "i < arr.length",
    range: { startLine: 5, endLine: 5 },
    status: "pending" as const,
  },
  {
    id: "sugg-3",
    type: "comment" as const,
    explanation: "Already applied",
    originalText: "",
    suggestedText: "",
    range: { startLine: 1, endLine: 1 },
    status: "accepted" as const,
  },
]

describe("SuggestionsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProposeCanvasReview.mockReturnValue({ id: "review-1" })
  })

  it("should render nothing when no pending suggestions and not generating", () => {
    const { container } = render(
      <SuggestionsPanel
        documentId="doc-1"
        suggestions={[mockSuggestions[2]]}
        isGenerating={false}
      />
    )
    expect(container.innerHTML).toBe("")
  })

  it("should render pending suggestions", () => {
    render(
      <SuggestionsPanel documentId="doc-1" suggestions={mockSuggestions} isGenerating={false} />
    )
    expect(screen.getByTestId("suggestion-sugg-1")).toBeInTheDocument()
    expect(screen.getByTestId("suggestion-sugg-2")).toBeInTheDocument()
    // Accepted suggestion should not be rendered
    expect(screen.queryByTestId("suggestion-sugg-3")).not.toBeInTheDocument()
  })

  it("should show count of pending suggestions", () => {
    render(
      <SuggestionsPanel documentId="doc-1" suggestions={mockSuggestions} isGenerating={false} />
    )
    expect(screen.getByText(/AI Suggestions/)).toBeInTheDocument()
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument()
  })

  it("should show loading state when generating", () => {
    render(<SuggestionsPanel documentId="doc-1" suggestions={[]} isGenerating={true} />)
    expect(screen.getByTestId("loader")).toBeInTheDocument()
    expect(screen.getByText("Generating suggestions...")).toBeInTheDocument()
  })

  it("should render when generating even with no pending suggestions", () => {
    const { container } = render(
      <SuggestionsPanel documentId="doc-1" suggestions={[]} isGenerating={true} />
    )
    expect(container.innerHTML).not.toBe("")
  })

  it("should pass correct props to SuggestionItem", () => {
    render(
      <SuggestionsPanel documentId="doc-1" suggestions={mockSuggestions} isGenerating={false} />
    )
    expect(screen.getByText("Improve variable naming")).toBeInTheDocument()
    expect(screen.getByText("Fix off-by-one error")).toBeInTheDocument()
  })

  it("keeps the legacy suggestion path as a direct apply", async () => {
    render(<SuggestionsPanel documentId="doc-1" suggestions={[mockSuggestions[0]]} />)
    await userEvent.click(screen.getByRole("button", { name: "Apply" }))
    expect(mockApplySuggestion).toHaveBeenCalledWith("doc-1", "sugg-1")
    expect(mockProposeCanvasReview).not.toHaveBeenCalled()
  })

  it("routes Workbench suggestions through proposal review", async () => {
    render(<SuggestionsPanel documentId="doc-1" suggestions={[mockSuggestions[0]]} proposalFirst />)
    await userEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(mockApplySuggestion).not.toHaveBeenCalled()
    expect(mockProposeCanvasReview).toHaveBeenCalledWith(
      "doc-1",
      "line 0\nconst count = 1;\nline 2",
      { requestId: "sugg-1", actionType: "improve" }
    )
    expect(mockUpdateSuggestionStatus).toHaveBeenCalledWith("doc-1", "sugg-1", "accepted")
  })
})
