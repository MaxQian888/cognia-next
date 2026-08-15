import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import { MessageShell } from "./message-shell"

const message: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [{ type: "text", text: "Hello" }],
  metadata: {
    createdAt: 1_700_000_000_000,
    run: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      durationMs: 1200,
      finishReason: "success",
    },
    usage: { inputTokens: 10, outputTokens: 20, totalCostUsd: 0.0123 },
  },
}

describe("MessageShell", () => {
  it("shows balanced identity, timestamp, model and progressive details", () => {
    render(
      <MessageShell message={message} display={resolveMessageDisplayOptions()}>
        <p>Hello</p>
      </MessageShell>
    )

    expect(screen.getByTestId("message-shell")).toHaveAttribute("data-preset", "balanced")
    // ADR-0127: body font travels as a data attribute the typeset CSS reads.
    expect(screen.getByTestId("message-shell")).toHaveAttribute("data-body-font", "sans")
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument()
    expect(screen.getByRole("time")).toHaveAttribute("dateTime", "2023-11-14T22:13:20.000Z")

    fireEvent.click(screen.getByRole("button", { name: "Message details" }))
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("↑10 ↓20")).toBeInTheDocument()
    expect(screen.getByText("$0.0123")).toBeInTheDocument()
  })

  it("omits unavailable historical metadata instead of guessing", () => {
    render(
      <MessageShell
        message={{ id: "legacy", role: "assistant", parts: [] }}
        display={resolveMessageDisplayOptions()}
      >
        Legacy
      </MessageShell>
    )
    expect(screen.queryByText("claude-sonnet-4-6")).toBeNull()
    expect(screen.queryByRole("time")).toBeNull()
  })

  it("applies layout, motion, user identity, and error status semantics", () => {
    const failedMessage: UIMessage = {
      ...message,
      metadata: { ...message.metadata, run: { finishReason: "error" } },
    }
    const { rerender } = render(
      <MessageShell
        message={failedMessage}
        display={resolveMessageDisplayOptions({
          preset: "inspector",
          overrides: { layout: "cards", motion: "off" },
        })}
      >
        Failed body
      </MessageShell>
    )
    expect(screen.getByTestId("message-shell")).toHaveAttribute("data-layout", "cards")
    expect(screen.getByTestId("message-shell")).toHaveAttribute("data-body-font", "sans")
    expect(screen.getByRole("status")).toHaveTextContent("Failed")

    rerender(
      <MessageShell
        message={{ ...message, role: "user" }}
        display={resolveMessageDisplayOptions({ preset: "focused" })}
      >
        User body
      </MessageShell>
    )
    expect(screen.getByText("You")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })
})
