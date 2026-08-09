/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import { SkillSuggestionCard } from "./skill-suggestion-card"

const mockPrepare = jest.fn()
jest.mock("@/lib/skills/session-suggestion", () => ({
  isSkillSuggestionEligible: (outcome: { completed: boolean }) => outcome.completed,
  prepareSkillRecordingFromSource: (...args: unknown[]) => mockPrepare(...args),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const eligible = {
  completed: true,
  turns: 3,
  errorCount: 0,
  denialCount: 0,
  toolCallTotal: 2,
  passedTests: 1,
  failedTests: 0,
  commitCount: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPrepare.mockResolvedValue({ recordingId: "recording-1", stepCount: 3 })
})

describe("SkillSuggestionCard", () => {
  it("does not read source content before the user confirms", () => {
    render(<SkillSuggestionCard source={{ kind: "session", sessionId: "s1" }} outcome={eligible} />)
    expect(screen.getByRole("button", { name: "skillSuggestion.action" })).toBeInTheDocument()
    expect(mockPrepare).not.toHaveBeenCalled()
  })

  it("opens the existing Recorder review flow after confirmation", async () => {
    render(<SkillSuggestionCard source={{ kind: "session", sessionId: "s1" }} outcome={eligible} />)
    fireEvent.click(screen.getByRole("button", { name: "skillSuggestion.action" }))

    await waitFor(() =>
      expect(mockPrepare).toHaveBeenCalledWith({ kind: "session", sessionId: "s1" })
    )
    expect(toast.success).toHaveBeenCalledWith("skillSuggestion.ready")
  })

  it("renders nothing when the deterministic outcome gate rejects the source", () => {
    const { container } = render(
      <SkillSuggestionCard
        source={{ kind: "session", sessionId: "s1" }}
        outcome={{ ...eligible, completed: false }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a localized failure without exposing source content", async () => {
    mockPrepare.mockRejectedValueOnce(new Error("secret transcript"))
    render(<SkillSuggestionCard source={{ kind: "session", sessionId: "s1" }} outcome={eligible} />)
    fireEvent.click(screen.getByRole("button", { name: "skillSuggestion.action" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("skillSuggestion.error"))
  })
})
