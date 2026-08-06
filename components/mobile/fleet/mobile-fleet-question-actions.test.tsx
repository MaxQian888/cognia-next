/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MobileFleetQuestionActions } from "./mobile-fleet-question-actions"
import { FLEET_PERMISSION_WAIT_MS, type PendingQuestion } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

const respondMock = jest.fn()
const rejectMock = jest.fn()
const forbiddenMock = jest.fn()
jest.mock("@/lib/fleet/fleet-remote-actions", () => ({
  fleetRemoteQuestionRespond: (...args: unknown[]) => respondMock(...args),
  fleetRemoteQuestionReject: (...args: unknown[]) => rejectMock(...args),
  isControlForbidden: (...args: unknown[]) => forbiddenMock(...args),
}))

const NOW = 1_000_000
jest.mock("@/hooks/fleet/use-now-ticker", () => ({ useNowTicker: () => NOW }))

const single: PendingQuestion = {
  question: "Which auth method?",
  header: "Auth",
  options: ["OAuth", "JWT", "Session"],
  multiSelect: false,
}
const multi: PendingQuestion = {
  question: "Which features?",
  options: ["A", "B"],
  multiSelect: true,
}

function renderCard(questions: PendingQuestion[] = [single], requestedAt = NOW) {
  return render(
    <MobileFleetQuestionActions
      request={{ requestId: "q-1", requestedAt }}
      questions={questions}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  respondMock.mockResolvedValue(true)
  rejectMock.mockResolvedValue(true)
  forbiddenMock.mockReturnValue(false)
})

describe("MobileFleetQuestionActions", () => {
  it("cannot submit until every question has an answer", () => {
    renderCard([single, multi])
    expect(screen.getByTestId("mobile-question-submit")).toBeDisabled()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-1"))
    // One of two answered — still incomplete.
    expect(screen.getByTestId("mobile-question-submit")).toBeDisabled()
    fireEvent.click(screen.getByTestId("mobile-question-option-1-0"))
    expect(screen.getByTestId("mobile-question-submit")).not.toBeDisabled()
  })

  it("sends option INDICES, not labels", async () => {
    // Labels are truncated for display in the snapshot, so a label-keyed answer
    // would not match the agent's real options.
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-2"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("q-1", [[2]]))
  })

  it("keeps one selection for single-select and several for multi-select", async () => {
    renderCard([multi])
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-option-0-1"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("q-1", [[0, 1]]))
  })

  it("replaces the choice on a single-select question", async () => {
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-option-0-1"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("q-1", [[1]]))
  })

  it("deselects a multi-select option on a second tap", async () => {
    renderCard([multi])
    const option = screen.getByTestId("mobile-question-option-0-0")
    fireEvent.click(option)
    expect(option.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(option)
    expect(option.getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByTestId("mobile-question-submit")).toBeDisabled()
  })

  it("confirms once the answer lands", async () => {
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(screen.getByTestId("mobile-question-answered")).toBeInTheDocument())
  })

  it("rejects without requiring an option selection", async () => {
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-reject"))
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith("q-1"))
    expect(screen.getByTestId("mobile-question-rejected")).toBeInTheDocument()
  })

  it("reports a lapsed answer window rather than claiming success", async () => {
    // The Rust side fails open when the hook timeout wins the race; the agent's
    // own terminal picker takes over, and the phone must say so.
    respondMock.mockResolvedValue(false)
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("expired"))
  })

  it("distinguishes a revoked control grant from a generic failure", async () => {
    respondMock.mockRejectedValue(new Error("remote_control_forbidden"))
    forbiddenMock.mockReturnValue(true)
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("controlLost"))
  })

  it("surfaces a send failure", async () => {
    respondMock.mockRejectedValue(new Error("boom"))
    renderCard()
    fireEvent.click(screen.getByTestId("mobile-question-option-0-0"))
    fireEvent.click(screen.getByTestId("mobile-question-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("failed"))
  })

  it("shows the expiry notice instead of dead controls once the window lapses", () => {
    renderCard([single], NOW - FLEET_PERMISSION_WAIT_MS - 1)
    expect(screen.getByTestId("mobile-question-expired")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-question-submit")).toBeNull()
  })

  it("counts the remaining answer window down", () => {
    renderCard([single], NOW - 5_000)
    expect(screen.getByTestId("mobile-question-countdown")).toHaveTextContent(
      `countdown:{"seconds":${(FLEET_PERMISSION_WAIT_MS - 5_000) / 1000}}`
    )
  })
})
