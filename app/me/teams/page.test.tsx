/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/teams-section", () => ({
  TeamsSection: () => <div data-testid="stub-teams" />,
}))

import Page from "./page"

describe("MobileTeamsPage", () => {
  it("renders the Teams section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-teams-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-teams")).toBeInTheDocument()
  })
})
