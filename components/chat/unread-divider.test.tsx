import { render, screen } from "@testing-library/react"

import { UnreadDivider } from "./unread-divider"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))

it("renders a labelled separator", () => {
  render(<UnreadDivider />)
  const divider = screen.getByTestId("unread-divider")
  expect(divider).toHaveAttribute("role", "separator")
  expect(divider).toHaveAttribute("aria-label", "t:label")
  expect(divider).toHaveTextContent("t:label")
})
