/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import enChat from "@/i18n/messages/en/chat.json"
import zhChat from "@/i18n/messages/zh-CN/chat.json"
import type { SelectionRunRequest, SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { MessageSelectionResultPanel } from "./message-selection-result-panel"

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown" data-streaming={isStreaming ? "true" : "false"}>
      {content}
    </div>
  ),
}))

const mockCopy = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy: mockCopy }),
}))

const result = enChat.selection.result

const request = (over: Partial<SelectionRunRequest> = {}): SelectionRunRequest => ({
  action: "summarize",
  quote: "Keep the cache warm between deploys.",
  sessionId: "s1",
  messageIds: ["m1"],
  context: "",
  ...over,
})

function renderPanel(run: Exclude<SelectionRunState, { status: "idle" }>, languageLabel?: string) {
  const handlers = {
    onStop: jest.fn(),
    onRetry: jest.fn(),
    onClose: jest.fn(),
    onReference: jest.fn(),
  }
  render(<MessageSelectionResultPanel run={run} languageLabel={languageLabel} {...handlers} />)
  return handlers
}

beforeEach(() => jest.clearAllMocks())

describe("MessageSelectionResultPanel", () => {
  it("titles the panel by action and names the selection it answers", () => {
    renderPanel({ status: "running", request: request(), text: "", progress: null })
    expect(screen.getByText(result.title.summarize)).toBeInTheDocument()
    expect(
      screen.getByText(result.source.replace("{title}", "Keep the cache warm between deploys."))
    ).toBeInTheDocument()
  })

  it("names what it was made from when that is not a text selection", () => {
    const handlers = {
      onStop: jest.fn(),
      onRetry: jest.fn(),
      onClose: jest.fn(),
      onReference: jest.fn(),
    }
    render(
      <MessageSelectionResultPanel
        run={{ status: "running", request: request(), text: "", progress: null }}
        sourceLabel="From 3 selected messages"
        {...handlers}
      />
    )
    expect(screen.getByText("From 3 selected messages")).toBeInTheDocument()
    // Not quoted as if the count were the words selected.
    expect(
      screen.queryByText(result.source.replace("{title}", "From 3 selected messages"))
    ).toBeNull()
  })

  // A phone sheet hosts it full-width rather than as a popover.
  it("takes the host's sizing over its popover default", () => {
    render(
      <MessageSelectionResultPanel
        run={{ status: "running", request: request(), text: "", progress: null }}
        className="w-full max-h-[45dvh]"
        onStop={jest.fn()}
        onRetry={jest.fn()}
        onClose={jest.fn()}
        onReference={jest.fn()}
      />
    )
    const panel = screen.getByTestId("message-selection-result")
    expect(panel).toHaveClass("w-full", "max-h-[45dvh]")
    expect(panel.className).not.toContain("w-[min(92vw,440px)]")
  })

  it("names the target language of a translation", () => {
    renderPanel(
      {
        status: "done",
        request: request({ action: "translate", targetLocale: "fr" }),
        text: "x",
        parts: 1,
      },
      "French"
    )
    expect(
      screen.getByText(result.title.translate.replace("{language}", "French"))
    ).toBeInTheDocument()
  })

  it("shows work in progress, then the streamed text, and offers only Stop while running", () => {
    const { onStop } = renderPanel({
      status: "running",
      request: request(),
      text: "",
      progress: null,
    })
    expect(screen.getByText(result.working)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: result.stop }))
    expect(onStop).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: result.reference })).toBeNull()
  })

  it("renders streaming text as streaming markdown", () => {
    renderPanel({ status: "running", request: request(), text: "So far", progress: null })
    expect(screen.getByTestId("markdown")).toHaveAttribute("data-streaming", "true")
  })

  it("reports per-part progress for long material, and the combining pass", () => {
    const { unmount } = render(
      <MessageSelectionResultPanel
        run={{
          status: "running",
          request: request(),
          text: "",
          progress: { done: 1, total: 4, combining: false },
        }}
        onStop={jest.fn()}
        onRetry={jest.fn()}
        onClose={jest.fn()}
        onReference={jest.fn()}
      />
    )
    expect(screen.getByTestId("message-selection-result-progress")).toHaveTextContent(
      result.part.replace("{done}", "2").replace("{total}", "4")
    )
    unmount()
    renderPanel({
      status: "running",
      request: request(),
      text: "",
      progress: { done: 3, total: 4, combining: true },
    })
    expect(screen.getByTestId("message-selection-result-progress")).toHaveTextContent(
      result.combining.replace("{total}", "3")
    )
  })

  it("offers copy and reference once done, and hands the result over", () => {
    const { onReference } = renderPanel({
      status: "done",
      request: request(),
      text: "A summary.",
      parts: 1,
    })
    fireEvent.click(screen.getByRole("button", { name: result.copy }))
    expect(mockCopy).toHaveBeenCalledWith("A summary.")
    fireEvent.click(screen.getByTestId("message-selection-result-reference"))
    expect(onReference).toHaveBeenCalledWith("A summary.")
    // A finished run has nothing to retry.
    expect(screen.queryByRole("button", { name: result.retry })).toBeNull()
  })

  it("keeps what streamed before a stop, usable and retryable", () => {
    const { onRetry } = renderPanel({ status: "stopped", request: request(), text: "Half" })
    expect(screen.getByText(result.stopped)).toBeInTheDocument()
    expect(screen.getByTestId("message-selection-result-reference")).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: result.retry }))
    expect(onRetry).toHaveBeenCalled()
  })

  it.each([
    ["no-client", result.unavailable.noClient],
    ["pii", result.unavailable.pii],
    ["no-output", result.unavailable.noOutput],
    ["empty", result.unavailable.empty],
  ] as const)("explains an unavailable run (%s) and offers no result", (reason, message) => {
    renderPanel({ status: "unavailable", request: request(), reason })
    expect(screen.getByRole("alert")).toHaveTextContent(message)
    expect(screen.queryByRole("button", { name: result.copy })).toBeNull()
    expect(screen.getByRole("button", { name: result.retry })).toBeInTheDocument()
  })

  it("shows a failure's reason and does not offer its partial text as a result", () => {
    renderPanel({ status: "failed", request: request(), text: "partial", message: "rate limited" })
    expect(screen.getByRole("alert")).toHaveTextContent(
      result.failed.replace("{reason}", "rate limited")
    )
    expect(screen.getByText("partial")).toBeInTheDocument()
    expect(screen.queryByTestId("message-selection-result-reference")).toBeNull()
  })

  it("closes from its own button", () => {
    const { onClose } = renderPanel({ status: "done", request: request(), text: "x", parts: 1 })
    fireEvent.click(screen.getByTestId("message-selection-result-close"))
    expect(onClose).toHaveBeenCalled()
  })

  // The unavailable reasons are picked by a computed key, which `lint:i18n`
  // cannot see; pin that every one resolves in both locales.
  it("has every reason and title in both catalogues", () => {
    for (const catalogue of [enChat, zhChat]) {
      const r = catalogue.selection.result
      for (const key of ["empty", "noClient", "noOutput", "pii"] as const) {
        expect(r.unavailable[key]).toEqual(expect.any(String))
      }
      for (const key of ["explain", "summarize", "translate"] as const) {
        expect(r.title[key]).toEqual(expect.any(String))
      }
    }
  })
})
