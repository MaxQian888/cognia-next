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
  usePathname: () => "/inbox/adapter/a1",
  redirect: jest.fn(),
}))

let mockParamsValue = { adapterId: "a1" }

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
  InboxShell: ({ view, adapterId }: { view: string; adapterId?: string; [k: string]: unknown }) => (
    <div data-testid="inbox-shell" data-view={view} data-adapter-id={adapterId}>
      InboxShell
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import AdapterInboxPage from "./page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdapterInboxPage (/inbox/adapter/[adapterId])", () => {
  beforeEach(() => {
    mockParamsValue = { adapterId: "a1" }
  })

  it("renders InboxShell with view=by-adapter", () => {
    render(<AdapterInboxPage params={Promise.resolve({ adapterId: "a1" })} />)
    const shell = screen.getByTestId("inbox-shell")
    expect(shell).toBeInTheDocument()
    expect(shell).toHaveAttribute("data-view", "by-adapter")
  })

  it("passes adapterId as scope filter", () => {
    mockParamsValue = { adapterId: "a99" }
    render(<AdapterInboxPage params={Promise.resolve({ adapterId: "a99" })} />)
    const shell = screen.getByTestId("inbox-shell")
    expect(shell).toHaveAttribute("data-adapter-id", "a99")
  })
})
