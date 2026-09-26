/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SessionRunIndicator } from "./session-run-indicator"

test.each([
  ["streaming", "row-run-streaming", "streaming"],
  ["awaiting_approval", "row-run-awaiting", "awaitingApproval"],
  ["error", "row-run-error", "error"],
] as const)("names the %s state as an image, not a live region", (status, testId, label) => {
  render(<SessionRunIndicator status={status} testIdPrefix="row-run" />)
  const glyph = screen.getByRole("img", { name: label })
  expect(glyph).toHaveAttribute("data-testid", testId)
  expect(glyph).not.toHaveAttribute("aria-hidden")
  expect(screen.queryByRole("status")).toBeNull()
})

test("draws nothing while idle", () => {
  const { container } = render(<SessionRunIndicator status="idle" testIdPrefix="row-run" />)
  expect(container).toBeEmptyDOMElement()
})
