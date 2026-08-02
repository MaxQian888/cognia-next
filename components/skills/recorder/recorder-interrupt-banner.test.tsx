/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { interruptIsRetriable, type RecorderInterrupt } from "@/lib/skills/recording/state-machine"
import type { InterruptReason } from "@/lib/skills/recording/types"

import { RecorderInterruptBanner } from "./recorder-interrupt-banner"

function interrupt(reason: InterruptReason): RecorderInterrupt {
  return { reason, from: "recording", retriable: interruptIsRetriable(reason) }
}

function renderBanner(value: RecorderInterrupt) {
  const onRetry = jest.fn()
  const onDiscard = jest.fn()
  render(<RecorderInterruptBanner interrupt={value} onRetry={onRetry} onDiscard={onDiscard} />)
  return { onRetry, onDiscard }
}

describe("RecorderInterruptBanner", () => {
  it("says why it stopped", () => {
    renderBanner(interrupt("limitReached"))
    expect(screen.getByText("reason.limitReached")).toBeInTheDocument()
  })

  it("has copy for every reason the native side can report", () => {
    const reasons: InterruptReason[] = [
      "killSwitch",
      "limitReached",
      "scopeLost",
      "permissionLost",
      "userInterrupt",
      "appShutdown",
      "nativeFailure",
    ]
    for (const reason of reasons) {
      const { unmount } = render(
        <RecorderInterruptBanner
          interrupt={interrupt(reason)}
          onRetry={jest.fn()}
          onDiscard={jest.fn()}
        />
      )
      expect(screen.getByText(`reason.${reason}`)).toBeInTheDocument()
      unmount()
    }
  })

  it("says nothing was lost — the journal survives every interrupt path", () => {
    // Which is what stops a kill switch feeling like a data-loss event.
    renderBanner(interrupt("appShutdown"))
    expect(screen.getByText("recoverable")).toBeInTheDocument()
  })

  it("offers to pick up where it stopped", async () => {
    const { onRetry } = renderBanner(interrupt("scopeLost"))
    await userEvent.click(screen.getByRole("button", { name: "retry" }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("offers no retry after a kill switch — that was an explicit stop", async () => {
    const { onDiscard } = renderBanner(interrupt("killSwitch"))
    expect(screen.queryByRole("button", { name: "retry" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "discard" }))
    expect(onDiscard).toHaveBeenCalled()
  })

  it("offers no retry after permission loss — that needs a settings trip", () => {
    renderBanner(interrupt("permissionLost"))
    expect(screen.queryByRole("button", { name: "retry" })).not.toBeInTheDocument()
  })

  it("always offers to discard", () => {
    renderBanner(interrupt("nativeFailure"))
    expect(screen.getByRole("button", { name: "discard" })).toBeInTheDocument()
  })
})
