import { act, fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import { useSettingsStore } from "@/stores/settings"
import { TooltipProvider } from "@/components/ui/tooltip"
import { METADATA_FIELDS, MessageShell } from "./message-shell"

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

  it("puts usage and cost in the header when that is the chosen placement", () => {
    // Every metadata field offers the same three placements, but the header
    // list used to be hand-written and omitted these two — so picking "header"
    // for usage or cost silently rendered nothing. Asserting on the header
    // element is what proves the placement, not just that the text appears.
    render(
      <MessageShell
        message={message}
        display={resolveMessageDisplayOptions(undefined, {
          preset: "balanced",
          overrides: {
            metadata: { usage: "header", cost: "header", model: "hidden", provider: "hidden" },
          },
        })}
      >
        <p>Hello</p>
      </MessageShell>
    )
    const header = screen.getByTestId("message-shell-header")
    expect(header).toHaveTextContent("↑10 ↓20")
    expect(header).toHaveTextContent("$0.0123")
  })

  it("keeps the metadata catalogue in step with the settings type", () => {
    // A field missing from METADATA_FIELDS is unrenderable in BOTH placements,
    // which is exactly how the usage/cost header gap survived: nothing pointed
    // at the mismatch.
    const resolved = resolveMessageDisplayOptions()
    expect([...METADATA_FIELDS].sort()).toEqual(Object.keys(resolved.metadata).sort())
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
      // `UIMessage["metadata"]` is `unknown` on the AI SDK type, so the spread
      // needs an object view of it.
      metadata: {
        ...(message.metadata as Record<string, unknown>),
        run: { finishReason: "error" },
      },
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

  describe("rooms", () => {
    // A named speaker means the message came out of a room: a character team, a
    // shared session, or an IM group. There the header is the only thing that
    // says which of several participants is talking.
    const hidden = resolveMessageDisplayOptions(undefined, {
      preset: "balanced",
      overrides: { metadata: { identity: "hidden" } },
    })

    it("shows the speaker even when the identity placement is hidden", () => {
      render(
        <MessageShell message={message} display={hidden} speakerName="Ana">
          <p>Hello</p>
        </MessageShell>
      )
      expect(screen.getByTestId("message-shell-header")).toHaveTextContent("Ana")
    })

    it("still honours a hidden identity in a direct chat, where nobody is named", () => {
      render(
        <MessageShell message={message} display={hidden}>
          <p>Hello</p>
        </MessageShell>
      )
      const header = screen.queryByTestId("message-shell-header")
      expect(header?.textContent ?? "").not.toContain("assistant")
    })

    it("renders the speaker's own avatar rather than the generic bot glyph", () => {
      render(
        <MessageShell
          message={message}
          display={resolveMessageDisplayOptions()}
          speakerName="Ana"
          speakerAvatar={{ name: "Ana", avatarEmoji: "🦊" }}
        >
          <p>Hello</p>
        </MessageShell>
      )
      expect(screen.getByTestId("message-shell-header")).toHaveTextContent("🦊")
    })

    it("falls back to initials when the speaker has no emoji or portrait", () => {
      render(
        <MessageShell
          message={message}
          display={resolveMessageDisplayOptions()}
          speakerName="Ada Lovelace"
          speakerAvatar={{ name: "Ada Lovelace" }}
        >
          <p>Hello</p>
        </MessageShell>
      )
      expect(screen.getByTestId("message-shell-header")).toHaveTextContent("AL")
    })
  })
})

describe("routing indicator (ADR-0043 Phase 12)", () => {
  const routedMessage: UIMessage = {
    ...message,
    metadata: {
      ...(message.metadata as Record<string, unknown>),
      run: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        finishReason: "success",
        routing: {
          mode: "auto",
          alias: "fast",
          strategy: "quality",
          reasonCodes: ["auto-task-fit"],
          candidateCount: 2,
        },
      },
    },
  }

  const hiddenMetadata = resolveMessageDisplayOptions(undefined, {
    preset: "balanced",
    overrides: {
      metadata: {
        identity: "hidden",
        timestamp: "hidden",
        model: "hidden",
        provider: "hidden",
        duration: "hidden",
        usage: "hidden",
        cost: "hidden",
        finishState: "hidden",
      },
    },
  })

  it("renders the chip in the header even when every metadata field is hidden", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <MessageShell message={routedMessage} display={hiddenMetadata}>
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    // The header only exists because the chip is in it — no other header
    // content survives the all-hidden metadata placement.
    const header = screen.getByTestId("message-shell-header")
    expect(header).toContainElement(screen.getByTestId("routing-indicator"))
    expect(screen.getByTestId("routing-indicator")).toHaveTextContent("Auto · fast")
  })

  it("hides the chip when showRoutingIndicator is off and restores afterwards", () => {
    const previous = useSettingsStore.getState().settings
    try {
      act(() => {
        useSettingsStore.setState({
          settings: {
            ...(previous ?? {}),
            autoRouting: {
              ...(previous?.autoRouting ?? {}),
              showRoutingIndicator: false,
            },
          } as typeof previous,
        })
      })
      render(
        <TooltipProvider delayDuration={0}>
          <MessageShell message={routedMessage} display={hiddenMetadata}>
            <p>Hello</p>
          </MessageShell>
        </TooltipProvider>
      )
      expect(screen.queryByTestId("routing-indicator")).toBeNull()
    } finally {
      act(() => {
        useSettingsStore.setState({ settings: previous })
      })
    }
  })

  it("stays off user messages and manual selections", () => {
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <MessageShell
          message={{ ...routedMessage, role: "user" }}
          display={resolveMessageDisplayOptions()}
        >
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    expect(screen.queryByTestId("routing-indicator")).toBeNull()

    rerender(
      <TooltipProvider delayDuration={0}>
        <MessageShell
          message={{
            ...routedMessage,
            metadata: {
              ...(routedMessage.metadata as Record<string, unknown>),
              run: {
                finishReason: "success",
                routing: {
                  mode: "manual",
                  strategy: "quality",
                  reasonCodes: ["manual-override"],
                  candidateCount: 1,
                },
              },
            },
          }}
          display={resolveMessageDisplayOptions()}
        >
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    expect(screen.queryByTestId("routing-indicator")).toBeNull()
  })
})

describe("per-member stop (ADR-0177 batch 3)", () => {
  it("offers the stop only while a named speaker is mid-reply, and names them", () => {
    const onStopSpeaker = jest.fn()
    const { rerender } = render(
      <MessageShell
        message={message}
        display={resolveMessageDisplayOptions()}
        speakerName="Ana"
        isStreaming
        onStopSpeaker={onStopSpeaker}
      >
        <p>Hello</p>
      </MessageShell>
    )
    const stop = screen.getByTestId("message-stop-speaker")
    expect(stop).toHaveAttribute("aria-label", "Stop Ana")
    fireEvent.click(stop)
    expect(onStopSpeaker).toHaveBeenCalledTimes(1)

    rerender(
      <MessageShell message={message} display={resolveMessageDisplayOptions()} speakerName="Ana">
        <p>Hello</p>
      </MessageShell>
    )
    expect(screen.queryByTestId("message-stop-speaker")).toBeNull()
  })
})

describe("Router + Fusion run card (ADR-0188)", () => {
  const withRouterFusion = (role: UIMessage["role"]): UIMessage => ({
    ...message,
    role,
    metadata: {
      ...(message.metadata as Record<string, unknown>),
      run: {
        finishReason: "success",
        routerFusion: { bypass: { code: "db_unavailable", justTripped: false } },
      },
    },
  })

  it("shows the card on an assistant message that went through Router + Fusion", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <MessageShell
          message={withRouterFusion("assistant")}
          display={resolveMessageDisplayOptions()}
        >
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    expect(screen.getByTestId("router-fusion-bypass")).toHaveTextContent("Not ledgered")
  })

  it("[ACC:OFF-02] renders no card for any other message", () => {
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <MessageShell message={message} display={resolveMessageDisplayOptions()}>
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    expect(screen.queryByTestId("router-fusion-bypass")).toBeNull()
    expect(screen.queryByTestId("router-fusion-run-card")).toBeNull()
    rerender(
      <TooltipProvider delayDuration={0}>
        <MessageShell message={withRouterFusion("user")} display={resolveMessageDisplayOptions()}>
          <p>Hello</p>
        </MessageShell>
      </TooltipProvider>
    )
    expect(screen.queryByTestId("router-fusion-bypass")).toBeNull()
  })
})
