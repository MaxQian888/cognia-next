/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"
import {
  HookNoticeMarker,
  HookNoticeRow,
  isHookNoticeMessage,
  type HookNoticePartData,
} from "./hook-notice-part"

function hookMessage(part: Partial<HookNoticePartData> = {}): UIMessage {
  const data: HookNoticePartData = {
    type: "hook-notice",
    event: "PreToolUse",
    toolName: "Bash",
    outcome: "blocked",
    block: "command matches denylist",
    warnings: [],
    ...part,
  }
  return {
    id: "hook-1",
    role: "system",
    parts: [data as unknown as UIMessage["parts"][number]],
  } as UIMessage
}

describe("isHookNoticeMessage", () => {
  it("is true for a system message carrying a single hook-notice part", () => {
    expect(isHookNoticeMessage(hookMessage())).toBe(true)
  })

  it("is false for a normal assistant message", () => {
    const m = { id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] } as UIMessage
    expect(isHookNoticeMessage(m)).toBe(false)
  })

  it("is false for a session-notice marker", () => {
    const m = {
      id: "n",
      role: "system",
      parts: [{ type: "session-notice" }],
    } as unknown as UIMessage
    expect(isHookNoticeMessage(m)).toBe(false)
  })
})

describe("HookNoticeMarker", () => {
  it("renders a single collapsed line with the event + outcome, body hidden", () => {
    render(<HookNoticeMarker message={hookMessage()} />)
    expect(screen.getByTestId("hook-notice-blocked")).toBeTruthy()
    expect(screen.getByText("Before tool")).toBeTruthy()
    expect(screen.getByText("· blocked")).toBeTruthy()
    expect(screen.getByTestId("hook-notice-tool").textContent).toBe("Bash")
    // Collapsed: the reason is not mounted until expanded.
    expect(screen.queryByTestId("hook-notice-reason")).toBeNull()
  })

  it("expands and collapses on trigger click", () => {
    render(<HookNoticeMarker message={hookMessage()} />)
    const trigger = screen.getByRole("button", { name: "Toggle hook details" })
    fireEvent.click(trigger)
    expect(screen.getByTestId("hook-notice-reason").textContent).toContain(
      "command matches denylist"
    )
    fireEvent.click(trigger)
    expect(screen.queryByTestId("hook-notice-reason")).toBeNull()
  })

  it("renders the context outcome and injected-context body", () => {
    render(
      <HookNoticeMarker
        message={hookMessage({
          event: "UserPromptSubmit",
          toolName: undefined,
          outcome: "context",
          block: undefined,
          additionalContext: "loaded 1.2KB of context",
        })}
      />
    )
    expect(screen.getByTestId("hook-notice-context")).toBeTruthy()
    expect(screen.getByText("Prompt submitted")).toBeTruthy()
    expect(screen.getByText("· context injected")).toBeTruthy()
    // No tool chip for a non-tool event.
    expect(screen.queryByTestId("hook-notice-tool")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Toggle hook details" }))
    expect(screen.getByText(/loaded 1.2KB of context/)).toBeTruthy()
  })

  it("renders the warning outcome with each warning listed", () => {
    render(
      <HookNoticeMarker
        message={hookMessage({
          event: "PostToolUse",
          outcome: "warning",
          block: undefined,
          warnings: ["hook timed out after 5000ms", "hook crashed: boom"],
        })}
      />
    )
    expect(screen.getByTestId("hook-notice-warning")).toBeTruthy()
    expect(screen.getByText("· warning")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Toggle hook details" }))
    const list = screen.getByTestId("hook-notice-warnings")
    expect(list.textContent).toContain("hook timed out after 5000ms")
    expect(list.textContent).toContain("hook crashed: boom")
  })

  it("falls back to the raw event identifier for unknown events", () => {
    render(<HookNoticeMarker message={hookMessage({ event: "SomeFutureEvent" })} />)
    expect(screen.getByText("SomeFutureEvent")).toBeTruthy()
  })

  it("renders directly from part data via HookNoticeRow (inline external-agent use)", () => {
    const data: HookNoticePartData = {
      type: "hook-notice",
      event: "PostToolUse",
      toolName: "Read",
      outcome: "warning",
      warnings: ["hook crashed: boom"],
    }
    render(<HookNoticeRow data={data} />)
    expect(screen.getByTestId("hook-notice-warning")).toBeTruthy()
    expect(screen.getByText("After tool")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Toggle hook details" }))
    expect(screen.getByTestId("hook-notice-warnings").textContent).toContain("hook crashed: boom")
  })

  it("defensively disables the trigger and shows no body for a degenerate fire", () => {
    // A fire with no block/context/warnings and an unrecognized outcome should
    // never reach the renderer (the Rust side gates it out), but the component
    // degrades gracefully: the bar colour falls back, the row has no chevron,
    // and the trigger is non-interactive.
    render(
      <HookNoticeMarker
        message={hookMessage({
          outcome: "weird" as never,
          block: undefined,
          additionalContext: undefined,
          warnings: [],
        })}
      />
    )
    const trigger = screen.getByRole("button", { name: "Toggle hook details" })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId("hook-notice-reason")).toBeNull()
    expect(screen.queryByTestId("hook-notice-warnings")).toBeNull()
  })
})
