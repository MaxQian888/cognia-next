/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import {
  BrowserAgentIndicator,
  useBrowserAgentActivity,
} from "@/components/browser/browser-agent-indicator"
import { emitAgentActivity } from "@/lib/browser/agent-activity"

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("BrowserAgentIndicator", () => {
  it("shows the agent-driving label + last action", () => {
    wrap(<BrowserAgentIndicator driver="agent" lastAction="click #go" />)
    expect(screen.getByText(/agent driving/i)).toBeInTheDocument()
    expect(screen.getByText(/click #go/)).toBeInTheDocument()
  })

  it("shows the human-driving label", () => {
    wrap(<BrowserAgentIndicator driver="human" lastAction={null} />)
    expect(screen.getByText(/you're driving/i)).toBeInTheDocument()
  })
})

describe("useBrowserAgentActivity", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("flips to agent on activity then relaxes back to human", () => {
    const { result } = renderHook(() => useBrowserAgentActivity())
    expect(result.current.driver).toBe("human")

    act(() => emitAgentActivity("click e3"))
    expect(result.current.driver).toBe("agent")
    expect(result.current.lastAction).toBe("click e3")

    act(() => jest.advanceTimersByTime(4000))
    expect(result.current.driver).toBe("human")
  })
})
