/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AiExplainPopover } from "./ai-explain-popover"

let mockState: {
  explaining: boolean
  error: string | null
  text: string | null
  explain: jest.Mock
}

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/git/use-ai-diff-explain", () => ({
  useAiDiffExplain: () => mockState,
}))

beforeEach(() => {
  mockState = { explaining: false, error: null, text: null, explain: jest.fn() }
})

function open() {
  return userEvent.click(screen.getByTestId("ai-explain-trigger"))
}

describe("AiExplainPopover", () => {
  it("renders the trigger button", () => {
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    expect(screen.getByTestId("ai-explain-trigger")).toBeInTheDocument()
  })

  it("auto-runs explain when opened with no prior text", async () => {
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    expect(mockState.explain).toHaveBeenCalledTimes(1)
  })

  it("does not re-run on open when text already exists", async () => {
    mockState = { ...mockState, text: "already" }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    expect(mockState.explain).not.toHaveBeenCalled()
    expect(screen.getByTestId("ai-explain-body")).toHaveTextContent("already")
  })

  it("shows the generating state", async () => {
    mockState = { ...mockState, explaining: true }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    expect(screen.getByTestId("ai-explain-body")).toHaveTextContent("explain.generating")
  })

  it("shows an error state", async () => {
    mockState = { ...mockState, error: "boom", text: null }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    expect(screen.getByTestId("ai-explain-body")).toHaveTextContent("explain.failed")
  })

  it("copies the explanation when Copy is clicked", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mockState = { ...mockState, text: "the summary" }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    await userEvent.click(screen.getByTestId("ai-explain-copy"))
    expect(writeText).toHaveBeenCalledWith("the summary")
  })

  it("toasts an error when copy fails", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"))
    Object.assign(navigator, { clipboard: { writeText } })
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    mockState = { ...mockState, text: "the summary" }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    await userEvent.click(screen.getByTestId("ai-explain-copy"))
    expect(toast.error).toHaveBeenCalled()
  })

  it("re-runs explain when Regenerate is clicked", async () => {
    mockState = { ...mockState, text: "old" }
    render(<AiExplainPopover subject="a.ts" diffText="diff" />)
    await open()
    await userEvent.click(screen.getByTestId("ai-explain-retry"))
    expect(mockState.explain).toHaveBeenCalledTimes(1)
  })
})
