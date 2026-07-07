/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the shared StatusBadge so this test targets PrStatusBadge's own logic
// (null-for-none + PR link) without pulling in motion/matchMedia.
jest.mock("@/components/status-badge", () => ({
  StatusBadge: ({ value, "data-testid": testid }: { value: string; "data-testid"?: string }) => (
    <span data-testid={testid}>{value}</span>
  ),
}))

import { PrStatusBadge } from "./pr-status-badge"

describe("PrStatusBadge", () => {
  it("renders nothing for the none status", () => {
    const { container } = render(<PrStatusBadge status="none" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the status label key for a real status", () => {
    render(<PrStatusBadge status="ci_failed" />)
    expect(screen.getByTestId("pr-status-badge")).toHaveTextContent("ciFailed")
    expect(screen.queryByTestId("pr-status-link")).toBeNull()
  })

  it("wraps the badge in a PR link when prUrl is given", () => {
    render(<PrStatusBadge status="mergeable" prUrl="https://gh/acme/app/pull/5" />)
    const link = screen.getByTestId("pr-status-link")
    expect(link).toHaveAttribute("href", "https://gh/acme/app/pull/5")
    expect(link).toHaveAttribute("target", "_blank")
    expect(screen.getByTestId("pr-status-badge")).toHaveTextContent("mergeable")
  })
})
