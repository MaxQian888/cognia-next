/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { SessionNoticeMarker, isSessionNoticeMessage } from "./session-notice-part"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const notice = (part: Record<string, unknown>): UIMessage =>
  ({
    id: "notice-1",
    role: "system",
    parts: [{ type: "session-notice", ...part }],
  }) as unknown as UIMessage

describe("isSessionNoticeMessage", () => {
  it("recognises the synthetic marker", () => {
    expect(isSessionNoticeMessage(notice({ variant: "rate-limit" }))).toBe(true)
  })

  it("rejects ordinary + other system messages", () => {
    const assistant = {
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as UIMessage
    expect(isSessionNoticeMessage(assistant)).toBe(false)
    const sys = {
      id: "s",
      role: "system",
      parts: [{ type: "text", text: "x" }],
    } as unknown as UIMessage
    expect(isSessionNoticeMessage(sys)).toBe(false)
  })
})

describe("SessionNoticeMarker", () => {
  it("renders a permission-denied notice with the tool name detail", () => {
    render(
      <SessionNoticeMarker message={notice({ variant: "permission-denied", toolName: "Bash" })} />
    )
    expect(screen.getByTestId("session-notice-permission-denied")).toBeInTheDocument()
    expect(screen.getByText("permissionDenied.label")).toBeInTheDocument()
    // detail key interpolates the tool name
    expect(screen.getByText(/permissionDenied\.detail.*Bash/)).toBeInTheDocument()
  })

  it("renders a rate-limit notice with reset time when present", () => {
    render(
      <SessionNoticeMarker
        message={notice({ variant: "rate-limit", status: "rejected", resetsAt: 1781869200 })}
      />
    )
    expect(screen.getByTestId("session-notice-rate-limit")).toBeInTheDocument()
    expect(screen.getByText("rateLimit.label")).toBeInTheDocument()
    expect(screen.getByText(/rateLimit\.detailWithReset/)).toBeInTheDocument()
  })

  it("rate-limit without resetsAt falls back to a bare status label", () => {
    render(
      <SessionNoticeMarker message={notice({ variant: "rate-limit", status: "allowed_warning" })} />
    )
    expect(screen.getByText(/rateLimit\.status\.warning/)).toBeInTheDocument()
  })
})
