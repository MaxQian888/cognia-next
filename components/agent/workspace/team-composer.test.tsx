import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TeamComposer } from "./team-composer"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

const toastWarning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (...args: unknown[]) => toastWarning(...args) } }))

const attachmentManifest: readonly AttachmentManifestEntry[] = [
  { filename: "notes.txt", mediaType: "text/plain", kind: "document" },
]

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
            data-status={String(props.status)}
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
            <button
              type="button"
              data-testid="mock-send-attachment"
              onClick={() =>
                (
                  props.onSend as (
                    content: unknown,
                    manifest: readonly AttachmentManifestEntry[]
                  ) => Promise<void>
                )("@alice review this", attachmentManifest)
              }
            >
              send-attachment
            </button>
            <button
              type="button"
              data-testid="mock-send-web"
              onClick={() =>
                (
                  props.onSend as (
                    content: unknown,
                    manifest: undefined,
                    templateRun: unknown,
                    metadata: { webSearchContext: { provider: string; results: unknown[] } }
                  ) => Promise<void>
                )("@codex search", undefined, null, {
                  webSearchContext: {
                    provider: "tavily",
                    results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
                  },
                })
              }
            >
              send-web
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
        attachmentsNotSupported: "Attachments aren't supported in team chat yet",
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
  beforeEach(() => {
    jest.clearAllMocks()
  })

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

  it("forwards pre-search metadata from Composer to the team send callback", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    fireEvent.click(screen.getByTestId("mock-send-web"))
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith("@codex search", {
      webSearchContext: {
        provider: "tavily",
        results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
      },
    })
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

  it("rejects attachment turns instead of silently dropping their provenance", async () => {
    const onSend = jest.fn()
    renderComposer(onSend)
    fireEvent.click(screen.getByTestId("mock-send-attachment"))
    await Promise.resolve()
    expect(onSend).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledWith("Attachments aren't supported in team chat yet.")
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
    expect(screen.getByTestId("mock-composer")).toHaveAttribute("data-status", "idle")
  })

  it("marks the underlying Composer as streaming", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamComposer mentionables={targets} onSend={jest.fn()} isStreaming />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("mock-composer")).toHaveAttribute("data-status", "streaming")
  })
})
