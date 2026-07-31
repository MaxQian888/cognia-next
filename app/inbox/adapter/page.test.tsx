/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

const mockGet = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ view, adapterId }: { view: string; adapterId?: string }) => (
    <div data-testid="inbox-shell" data-view={view} data-adapter-id={adapterId}>
      InboxShell
    </div>
  ),
}))

import AdapterInboxPage from "./page"

beforeEach(() => jest.clearAllMocks())

describe("AdapterInboxPage (/inbox/adapter?adapterId=)", () => {
  it("renders InboxShell with view=by-adapter", () => {
    mockGet.mockReturnValue("a1")
    render(<AdapterInboxPage />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-view", "by-adapter")
  })

  it("passes ?adapterId= as scope filter", () => {
    mockGet.mockReturnValue("a99")
    render(<AdapterInboxPage />)
    expect(screen.getByTestId("inbox-shell")).toHaveAttribute("data-adapter-id", "a99")
  })
})
