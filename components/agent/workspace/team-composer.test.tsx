import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TeamComposer } from "./team-composer"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

// The full Composer is heavy — mock it so the test exercises only TeamComposer's wrapper logic.
jest.mock("@/components/chat/composer", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    Composer: React.forwardRef<unknown, Record<string, unknown>>(
      function MockComposer(props, _ref) {
        return (
          <div
            data-testid="mock-composer"
            data-mention-mode={String(props.mentionMode)}
            data-mention-count={
              Array.isArray(props.mentionables) ? (props.mentionables as MentionTarget[]).length : 0
            }
            data-placeholder={typeof props.placeholder === "string" ? props.placeholder : ""}
          >
            <button
              type="button"
              data-testid="mock-send-text"
              onClick={() =>
                (props.onSend as (content: unknown) => Promise<void>)("@codex hi there")
              }
            >
              send-text
            </button>
            <button
              type="button"
              data-testid="mock-send-blocks"
              onClick={() =>
                (props.onSend as (content: unknown) => Promise<void>)([
                  { type: "image", source: { data: "x" } },
                  { type: "text", text: "@alice please review" },
                ])
              }
            >
              send-blocks
            </button>
            <button
              type="button"
              data-testid="mock-send-empty"
              onClick={() => (props.onSend as (content: unknown) => Promise<void>)("   \n  ")}
            >
              send-empty
            </button>
          </div>
        )
      }
    ),
  }
})

const messages = {
  agentTeamsWorkspace: {
    chat: {
      streaming: "Thinking…",
      composer: {
        placeholder: "Type @ to mention an agent — try @claude or @codex",
        imageNotSupported: "Image attachments aren't supported yet",
        stop: "Stop",
      },
    },
  },
}

const targets: MentionTarget[] = [
  {
    kind: "virtual",
    id: "__virtual_claude__",
    name: "claude",
    runtime: "claude",
    description: "Anthropic Claude API",
  },
]

function renderComposer(onSend: jest.Mock) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TeamComposer mentionables={targets} onSend={onSend} />
    </NextIntlClientProvider>
  )
}

describe("TeamComposer", () => {
  it("forwards mentionMode + mentionables + placeholder to the underlying Composer", () => {
    renderComposer(jest.fn())
    const mock = screen.getByTestId("mock-composer")
    expect(mock).toHaveAttribute("data-mention-mode", "agents")
    expect(mock).toHaveAttribute("data-mention-count", "1")
    expect(mock).toHaveAttribute(
      "data-placeholder",
      "Type @ to mention an agent — try @claude or @codex"
    )
  })

  it("calls onSend with the trimmed text when the inner Composer fires", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    fireEvent.click(screen.getByTestId("mock-send-text"))
    // wait a microtask for the async handler to settle
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith("@codex hi there")
  })

  it("flattens block content into text and surfaces a warning for image blocks", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    fireEvent.click(screen.getByTestId("mock-send-blocks"))
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith("@alice please review")
  })

  it("ignores empty/whitespace input", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    fireEvent.click(screen.getByTestId("mock-send-empty"))
    await Promise.resolve()
    expect(onSend).not.toHaveBeenCalled()
  })

  it("renders the streaming banner with a stop button when isStreaming is true", () => {
    const onStop = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamComposer mentionables={targets} onSend={jest.fn()} onStop={onStop} isStreaming />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("team-composer-streaming-banner")).toBeInTheDocument()
    expect(screen.getByText("Thinking…")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("team-composer-stop"))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("hides the streaming banner when isStreaming is false", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamComposer mentionables={targets} onSend={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("team-composer-streaming-banner")).toBeNull()
  })
})
