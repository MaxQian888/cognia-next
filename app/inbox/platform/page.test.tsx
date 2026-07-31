/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockGet = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ view, platformKind }: { view: string; platformKind?: string }) => (
    <div data-testid="inbox-shell" data-view={view} data-platform-kind={platformKind}>
      InboxShell
    </div>
  ),
}))

import PlatformInboxPage from "./page"

beforeEach(() => jest.clearAllMocks())

describe("PlatformInboxPage (/inbox/platform?kind=)", () => {
  it("renders InboxShell with view=by-platform", () => {
    mockGet.mockReturnValue("telegram")
    render(<PlatformInboxPage />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-view", "by-platform")
  })

  it("passes ?kind= as scope filter", () => {
    mockGet.mockReturnValue("discord")
    render(<PlatformInboxPage />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-platform-kind", "discord")
  })
})
