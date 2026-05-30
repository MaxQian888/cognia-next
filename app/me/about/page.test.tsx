/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/about/about-section", () => ({
  AboutSection: () => <div data-testid="stub-about-section" />,
}))

import Page from "./page"

describe("MobileAboutPage", () => {
  it("renders AboutSection inside the SubPageShell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-about-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-about-section")).toBeInTheDocument()
  })
})
