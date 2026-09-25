/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IslandQuestionActions } from "./island-question-actions"
import { FLEET_PERMISSION_WAIT_MS, type PendingQuestion } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const respondMock = jest.fn<Promise<boolean>, [string, number[][]]>()
const rejectMock = jest.fn<Promise<boolean>, [string]>()

const SINGLE: PendingQuestion = {
  question: "Which auth method?",
  header: "Auth",
  options: ["OAuth", "API key"],
  multiSelect: false,
}
const MULTI: PendingQuestion = {
  question: "Which sections?",
  options: ["Intro", "Body", "Outro"],
  multiSelect: true,
}

/** A hook-ingress ask: answerable for its window, then back to the terminal. */
function props(requestedAt = Date.now()) {
  return {
    request: { requestId: "q-1", requestedAt },
    deadline: { at: requestedAt + FLEET_PERMISSION_WAIT_MS, fallback: "terminal" as const },
    respond: respondMock,
    reject: rejectMock,
  }
}

beforeEach(() => {
  respondMock.mockReset()
  respondMock.mockResolvedValue(true)
  rejectMock.mockReset()
  rejectMock.mockResolvedValue(true)
})

describe("IslandQuestionActions", () => {
  it("renders each question with header, options, countdown and submit", () => {
    render(<IslandQuestionActions {...props()} questions={[SINGLE, MULTI]} />)
    expect(screen.getByText("Which auth method?")).toBeInTheDocument()
    expect(screen.getByText("Auth")).toBeInTheDocument()
    // Only the multi-select question shows the multi hint.
    expect(screen.getByTestId("question-multiselect-1")).toBeInTheDocument()
    expect(screen.queryByTestId("question-multiselect-0")).toBeNull()
    expect(screen.getByTestId("question-option-0-0")).toHaveTextContent("OAuth")
    expect(screen.getByTestId("question-countdown")).toBeInTheDocument()
    expect(screen.getByTestId("question-submit")).toBeInTheDocument()
    expect(screen.getByTestId("question-reject")).toBeInTheDocument()
  })

  it("rejects the native question without requiring a selection", async () => {
    render(<IslandQuestionActions {...props()} questions={[SINGLE]} />)
    fireEvent.click(screen.getByTestId("question-reject"))
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith("q-1"))
    expect(await screen.findByTestId("question-rejected")).toBeInTheDocument()
  })

  it("keeps submit disabled until every question is answered", () => {
    render(<IslandQuestionActions {...props()} questions={[SINGLE, MULTI]} />)
    const submit = screen.getByTestId("question-submit")
    expect(submit).toBeDisabled()
    // Answer only the first question — still disabled.
    fireEvent.click(screen.getByTestId("question-option-0-0"))
    expect(submit).toBeDisabled()
    // Answer the second — now enabled.
    fireEvent.click(screen.getByTestId("question-option-1-1"))
    expect(submit).toBeEnabled()
  })

  it("single-select replaces the prior choice; posts option indices", async () => {
    render(<IslandQuestionActions {...props()} questions={[SINGLE]} />)
    fireEvent.click(screen.getByTestId("question-option-0-0")) // OAuth
    expect(screen.getByTestId("question-option-0-0")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByTestId("question-option-0-1")) // API key replaces
    expect(screen.getByTestId("question-option-0-0")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("question-option-0-1")).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByTestId("question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("q-1", [[1]]))
    expect(screen.getByTestId("question-submitted")).toBeInTheDocument()
  })

  it("multi-select accumulates and toggles off selections", async () => {
    render(<IslandQuestionActions {...props()} questions={[MULTI]} />)
    fireEvent.click(screen.getByTestId("question-option-0-0")) // Intro
    fireEvent.click(screen.getByTestId("question-option-0-2")) // Outro
    fireEvent.click(screen.getByTestId("question-option-0-0")) // toggle Intro off
    fireEvent.click(screen.getByTestId("question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("q-1", [[2]]))
  })

  it("stays un-submitted when the Rust side reports the request already gone", async () => {
    respondMock.mockResolvedValue(false)
    render(<IslandQuestionActions {...props()} questions={[SINGLE]} />)
    fireEvent.click(screen.getByTestId("question-option-0-0"))
    fireEvent.click(screen.getByTestId("question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalled())
    expect(screen.queryByTestId("question-submitted")).toBeNull()
  })

  it("shows the expired state past the answer window and disables options", () => {
    jest.useFakeTimers()
    try {
      render(
        <IslandQuestionActions
          {...props(Date.now() - FLEET_PERMISSION_WAIT_MS + 1500)}
          questions={[SINGLE]}
        />
      )
      expect(screen.getByTestId("question-countdown")).toBeInTheDocument()
      act(() => {
        jest.advanceTimersByTime(3000)
      })
      expect(screen.getByTestId("question-expired")).toBeInTheDocument()
      expect(screen.getByTestId("question-option-0-0")).toBeDisabled()
      expect(screen.queryByTestId("question-submit")).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("waits without a countdown for an ask that never lapses", () => {
    jest.useFakeTimers()
    try {
      render(
        <IslandQuestionActions
          {...props(Date.now() - 10 * FLEET_PERMISSION_WAIT_MS)}
          deadline={null}
          questions={[SINGLE]}
        />
      )
      expect(screen.queryByTestId("question-countdown")).toBeNull()
      expect(screen.queryByTestId("question-progress-track")).toBeNull()
      expect(screen.queryByTestId("question-expired")).toBeNull()
      expect(screen.getByTestId("question-option-0-0")).toBeEnabled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("says a lapsing ask lapsed instead of pointing at a terminal", () => {
    jest.useFakeTimers()
    try {
      const now = Date.now()
      render(
        <IslandQuestionActions
          {...props(now)}
          deadline={{ at: now + 1_000, fallback: "lapse" }}
          questions={[SINGLE]}
        />
      )
      act(() => {
        jest.advanceTimersByTime(2_000)
      })
      expect(screen.getByTestId("question-expired")).toHaveTextContent("permission.lapsed")
    } finally {
      jest.useRealTimers()
    }
  })
})
