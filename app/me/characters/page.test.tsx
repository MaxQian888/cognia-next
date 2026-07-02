/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/characters-section", () => ({
  CharactersSection: () => <div data-testid="stub-characters" />,
}))

import Page from "./page"

describe("MobileCharactersPage", () => {
  it("renders the Characters section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-characters-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-characters")).toBeInTheDocument()
  })
})
