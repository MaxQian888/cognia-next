/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/sections/skills-section", () => ({
  SkillsSection: () => <div data-testid="stub-skills" />,
}))

import Page from "./page"

describe("MobileSkillsPage", () => {
  it("renders the Skills section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-skills-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-skills")).toBeInTheDocument()
  })
})
