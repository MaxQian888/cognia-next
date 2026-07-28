/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"

const mockUseLastInbound = jest.fn<number | null, [unknown?]>(() => null)
jest.mock("@/hooks/connectors/use-last-inbound", () => ({
  useLastInboundForConversation: (key: string | null | undefined) => mockUseLastInbound(key),
}))
jest.mock("@/components/ui/tooltip")

import { LastInboundChip } from "./last-inbound-chip"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function renderChip(conversationKey = "telegram:a1:c1") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LastInboundChip conversationKey={conversationKey} />
    </NextIntlClientProvider>
  )
}

function chipText(): string {
  return screen.getByTestId("conversation-header-last-inbound").textContent ?? ""
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("LastInboundChip", () => {
  // An empty conversation would otherwise render a "Last message —" placeholder.
  it("renders nothing when no inbound has ever landed", () => {
    mockUseLastInbound.mockReturnValue(null)
    const { container } = renderChip()
    expect(container).toBeEmptyDOMElement()
  })

  it("reads the newest inbound for the conversation it was given", () => {
    mockUseLastInbound.mockReturnValue(Date.now())
    renderChip("lark:bot-7:oc_x")
    expect(mockUseLastInbound).toHaveBeenCalledWith("lark:bot-7:oc_x")
  })

  it("says just now under a minute", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 20_000)
    renderChip()
    expect(chipText()).toMatch(/just now/i)
  })

  it("counts in minutes under an hour", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 5 * MINUTE)
    renderChip()
    expect(chipText()).toMatch(/5\s*min/i)
  })

  it("counts in hours under two days", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 6 * HOUR)
    renderChip()
    expect(chipText()).toMatch(/6\s*h/i)
  })

  it("counts in days past 48 hours", () => {
    mockUseLastInbound.mockReturnValue(Date.now() - 72 * HOUR)
    renderChip()
    expect(chipText()).toMatch(/3\s*d/i)
  })

  // A future timestamp (clock skew between the device and the platform) must
  // not render a negative age.
  it("clamps a future timestamp to just now", () => {
    mockUseLastInbound.mockReturnValue(Date.now() + 10 * MINUTE)
    renderChip()
    expect(chipText()).toMatch(/just now/i)
  })

  it("re-ticks every 30s so the age does not go stale", () => {
    jest.useFakeTimers()
    try {
      mockUseLastInbound.mockReturnValue(Date.now() - 59 * MINUTE)
      renderChip()
      expect(chipText()).toMatch(/59\s*min/i)

      act(() => {
        jest.advanceTimersByTime(2 * MINUTE)
      })

      // Crossed the hour boundary without a re-render from upstream.
      expect(chipText()).toMatch(/1\s*h/i)
    } finally {
      jest.useRealTimers()
    }
  })

  // The chip lives in the header's overflow popover now, which is not
  // width-constrained by the header strip.
  it("is not hidden on narrow viewports", () => {
    mockUseLastInbound.mockReturnValue(Date.now())
    renderChip()
    expect(screen.getByTestId("conversation-header-last-inbound")).not.toHaveClass("hidden")
  })
})
