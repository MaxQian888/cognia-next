/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/a2ui-section", () => ({
  A2UISection: () => <div data-testid="stub-a2ui" />,
}))

import Page from "./page"

describe("MobileA2uiPage", () => {
  it("renders the A2UI section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-a2ui-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-a2ui")).toBeInTheDocument()
  })
})
