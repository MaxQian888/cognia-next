/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import React from "react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox/platform/telegram",
  redirect: jest.fn(),
}))

let mockParamsValue = { kind: "telegram" }

jest.mock("react", () => {
  const actual = jest.requireActual<typeof React>("react")
  return {
    ...actual,
    use: (p: unknown) => {
      if (p && typeof (p as { then?: unknown }).then === "function") {
        return mockParamsValue
      }
      return actual.use(p as Parameters<typeof actual.use>[0])
    },
  }
})

jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({
    view,
    platformKind,
  }: {
    view: string
    platformKind?: string
    [k: string]: unknown
  }) => (
    <div data-testid="inbox-shell" data-view={view} data-platform-kind={platformKind}>
      InboxShell
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import PlatformInboxPage from "./page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlatformInboxPage (/inbox/platform/[kind])", () => {
  beforeEach(() => {
    mockParamsValue = { kind: "telegram" }
  })

  it("renders InboxShell with view=by-platform", () => {
    render(<PlatformInboxPage params={Promise.resolve({ kind: "telegram" })} />)
    const shell = screen.getByTestId("inbox-shell")
    expect(shell).toBeInTheDocument()
    expect(shell).toHaveAttribute("data-view", "by-platform")
  })

  it("passes platformKind as scope filter", () => {
    mockParamsValue = { kind: "discord" }
    render(<PlatformInboxPage params={Promise.resolve({ kind: "discord" })} />)
    const shell = screen.getByTestId("inbox-shell")
    expect(shell).toHaveAttribute("data-platform-kind", "discord")
  })
})
