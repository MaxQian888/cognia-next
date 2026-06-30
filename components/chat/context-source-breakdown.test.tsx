/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"

import { ContextSourceBreakdown } from "./context-source-breakdown"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Avoid pulling the full indicator tree; stub the shared row.
jest.mock("@/components/chat/context-usage-indicator", () => ({
  UsageRow: ({ label, slot }: { label: string; slot: React.ReactNode }) => (
    <div data-testid="usage-row" data-label={label}>
      {slot}
    </div>
  ),
}))

const user = (text: string): UIMessage =>
  ({ id: "u", role: "user", parts: [{ type: "text", text }] }) as unknown as UIMessage

describe("ContextSourceBreakdown", () => {
  it("renders a row per non-empty source", () => {
    render(<ContextSourceBreakdown messages={[user("hello world this is a message")]} />)
    expect(screen.getByTestId("context-source-breakdown")).toBeInTheDocument()
    const rows = screen.getAllByTestId("usage-row")
    expect(rows.some((r) => r.getAttribute("data-label") === "breakdownUserMessages")).toBe(true)
  })

  it("renders nothing for an empty transcript", () => {
    const { container } = render(<ContextSourceBreakdown messages={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("hides itself in simplified usage-display mode", () => {
    const { container } = render(
      <ContextSourceBreakdown messages={[user("hello world")]} mode="simplified" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
