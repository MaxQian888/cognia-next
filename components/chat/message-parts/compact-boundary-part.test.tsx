/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { CompactBoundaryMarker, isCompactBoundaryMessage } from "./compact-boundary-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const boundary = (part: Record<string, unknown>): UIMessage =>
  ({
    id: "compact-1",
    role: "system",
    parts: [{ type: "compact-boundary", ...part }],
  }) as unknown as UIMessage

describe("isCompactBoundaryMessage", () => {
  it("recognises the synthetic marker", () => {
    expect(isCompactBoundaryMessage(boundary({}))).toBe(true)
  })

  it("rejects ordinary messages", () => {
    const assistant = {
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as UIMessage
    expect(isCompactBoundaryMessage(assistant)).toBe(false)
  })

  it("rejects a system message that is not a boundary", () => {
    const sys = {
      id: "s",
      role: "system",
      parts: [{ type: "text", text: "x" }],
    } as unknown as UIMessage
    expect(isCompactBoundaryMessage(sys)).toBe(false)
  })
})

describe("CompactBoundaryMarker", () => {
  it("shows the before/after token detail when both counts are present", () => {
    render(<CompactBoundaryMarker message={boundary({ preTokens: 120000, postTokens: 8000 })} />)
    expect(screen.getByTestId("compact-boundary")).toBeInTheDocument()
    // Echoed key carries the compact-formatted from/to numbers.
    expect(screen.getByText(/detail:.*120K.*8K/)).toBeInTheDocument()
  })

  it("falls back to the manual label when token counts are absent", () => {
    render(<CompactBoundaryMarker message={boundary({ trigger: "manual" })} />)
    expect(screen.getByText(/manual/)).toBeInTheDocument()
  })

  it("falls back to the auto label otherwise", () => {
    render(<CompactBoundaryMarker message={boundary({ trigger: "auto" })} />)
    expect(screen.getByText(/auto/)).toBeInTheDocument()
  })
})
