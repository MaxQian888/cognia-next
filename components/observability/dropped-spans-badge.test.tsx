/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { DroppedSpansBadge } from "./dropped-spans-badge"
import { getMissingProviderTraceContextCount } from "@/lib/claude/provider-telemetry"

jest.mock("@/lib/claude/provider-telemetry", () => ({
  getMissingProviderTraceContextCount: jest.fn(() => 0),
}))

const mockedCount = getMissingProviderTraceContextCount as jest.MockedFunction<
  typeof getMissingProviderTraceContextCount
>

function renderBadge(refreshKey: number | null = 1) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DroppedSpansBadge refreshKey={refreshKey} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockedCount.mockReset()
  mockedCount.mockReturnValue(0)
})

describe("DroppedSpansBadge", () => {
  it("renders nothing while no spans have been dropped", async () => {
    renderBadge()
    await waitFor(() => expect(mockedCount).toHaveBeenCalled())
    expect(screen.queryByTestId("dropped-spans-badge")).toBeNull()
  })

  it("surfaces the count once spans start being dropped", async () => {
    mockedCount.mockReturnValue(3)
    renderBadge()
    const badge = await screen.findByTestId("dropped-spans-badge")
    expect(badge).toHaveTextContent("3 spans dropped")
  })

  it("uses the singular form for exactly one dropped span", async () => {
    mockedCount.mockReturnValue(1)
    renderBadge()
    const badge = await screen.findByTestId("dropped-spans-badge")
    expect(badge).toHaveTextContent("1 span dropped")
  })

  it("carries an accessible label explaining the cause", async () => {
    mockedCount.mockReturnValue(2)
    renderBadge()
    const badge = await screen.findByTestId("dropped-spans-badge")
    expect(badge.getAttribute("aria-label")).toContain("trace context")
  })

  it("re-reads the counter when the refresh key changes", async () => {
    mockedCount.mockReturnValue(0)
    const { rerender } = renderBadge(1)
    await waitFor(() => expect(mockedCount).toHaveBeenCalled())
    expect(screen.queryByTestId("dropped-spans-badge")).toBeNull()

    mockedCount.mockReturnValue(5)
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DroppedSpansBadge refreshKey={2} />
      </NextIntlClientProvider>
    )
    const badge = await screen.findByTestId("dropped-spans-badge")
    expect(badge).toHaveTextContent("5 spans dropped")
  })
})
