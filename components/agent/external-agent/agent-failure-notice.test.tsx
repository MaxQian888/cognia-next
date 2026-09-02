/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import type { ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"

import { AgentFailureNotice } from "./agent-failure-notice"

const labels = (en.externalAgent as unknown as { failure: Record<string, string> }).failure

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    {ui}
  </NextIntlClientProvider>
)

const failure = (overrides: Partial<ExternalAgentFailure> = {}): ExternalAgentFailure => ({
  agentId: "pi-1",
  phase: "connect",
  message: "could not start the process",
  causes: [],
  at: 1,
  ...overrides,
})

describe("AgentFailureNotice", () => {
  it("names the phase and the message", () => {
    render(wrap(<AgentFailureNotice failure={failure()} onDismiss={() => {}} />))
    expect(screen.getByText(labels.connect)).toBeInTheDocument()
    expect(screen.getByText("could not start the process")).toBeInTheDocument()
  })

  it("shows the causes the outer message was wrapping", () => {
    // The wrapper alone is the difference between "could not connect" and the
    // sentence that says what to do about it.
    render(
      wrap(
        <AgentFailureNotice
          failure={failure({ causes: ["Could not determine the Pi version"] })}
          onDismiss={() => {}}
        />
      )
    )
    expect(screen.getByText(labels.causes)).toBeInTheDocument()
    expect(screen.getByText("Could not determine the Pi version")).toBeInTheDocument()
  })

  it("omits the causes block entirely when there is nothing to wrap", () => {
    render(wrap(<AgentFailureNotice failure={failure()} onDismiss={() => {}} />))
    expect(screen.queryByText(labels.causes)).toBeNull()
  })

  it("offers a retry that runs the failed action again", () => {
    const onRetry = jest.fn()
    render(wrap(<AgentFailureNotice failure={failure()} onRetry={onRetry} onDismiss={() => {}} />))
    fireEvent.click(screen.getByRole("button", { name: new RegExp(labels.retry, "i") }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("renders no retry when retrying makes no sense", () => {
    // A blocked transport is not something a second press fixes.
    render(wrap(<AgentFailureNotice failure={failure()} onDismiss={() => {}} />))
    expect(screen.queryByRole("button", { name: new RegExp(labels.retry, "i") })).toBeNull()
  })

  it("disables the retry while one is already in flight", () => {
    render(
      wrap(
        <AgentFailureNotice failure={failure()} onRetry={() => {}} onDismiss={() => {}} retrying />
      )
    )
    expect(screen.getByRole("button", { name: new RegExp(labels.retrying, "i") })).toBeDisabled()
  })

  it("dismisses without swallowing the click into the row behind it", () => {
    // The notice sits inside a card whose own onClick selects the agent.
    const onDismiss = jest.fn()
    const onSelect = jest.fn()
    render(
      wrap(
        <div onClick={onSelect}>
          <AgentFailureNotice failure={failure()} onDismiss={onDismiss} />
        </div>
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("survives a browser with no clipboard, which is how a paired tab reaches a Host", () => {
    const original = navigator.clipboard
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    render(wrap(<AgentFailureNotice failure={failure()} onDismiss={() => {}} />))
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: new RegExp(labels.copy, "i") }))
    ).not.toThrow()
    Object.defineProperty(navigator, "clipboard", { value: original, configurable: true })
  })
})
