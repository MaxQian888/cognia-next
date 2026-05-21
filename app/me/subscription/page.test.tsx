/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/subscription/subscription-section", () => ({
  SubscriptionSection: () => <div data-testid="stub-subscription" />,
}))

import Page from "./page"

describe("MobileSubscriptionPage", () => {
  it("renders the subscription section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-subscription-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-subscription")).toBeInTheDocument()
  })
})
