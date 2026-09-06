/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/companion/cloud-deployment-card", () => ({
  CloudDeploymentCard: () => <div data-testid="stub-deployment-card" />,
}))

import Page from "./page"

describe("MobileCloudAccountPage", () => {
  it("renders the desktop deployment card inside the mobile shell", () => {
    // The point of the route is that it embeds the SAME card the desktop uses
    // rather than a phone-shaped copy. A second implementation is how the two
    // drift, and the card is host-neutral.
    render(<Page />)
    expect(screen.getByTestId("mobile-cloud-account-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-deployment-card")).toBeInTheDocument()
  })

  it("titles the page from the mobile.me namespace", () => {
    render(<Page />)
    expect(screen.getByText("cloudAccountRow")).toBeInTheDocument()
  })
})
