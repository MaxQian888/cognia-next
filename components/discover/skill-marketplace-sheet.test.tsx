/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SkillMarketplaceSheet } from "./skill-marketplace-sheet"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The real marketplace pulls in useSkillMarketplace + Dexie; stub it so the
// test focuses on the sheet wiring.
jest.mock("@/components/skills/skill-marketplace", () => ({
  SkillMarketplace: () => <div data-testid="stub-skill-marketplace" />,
}))

describe("<SkillMarketplaceSheet />", () => {
  it("renders a default trigger and opens the sheet embedding the marketplace", async () => {
    const user = userEvent.setup()
    render(<SkillMarketplaceSheet />)
    expect(screen.queryByTestId("stub-skill-marketplace")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("discover-skill-marketplace-trigger"))
    expect(screen.getByTestId("discover-skill-marketplace-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("stub-skill-marketplace")).toBeInTheDocument()
  })

  it("accepts a custom trigger override", async () => {
    const user = userEvent.setup()
    render(<SkillMarketplaceSheet trigger={<button data-testid="custom-trigger">open</button>} />)
    expect(screen.queryByTestId("discover-skill-marketplace-trigger")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("custom-trigger"))
    expect(screen.getByTestId("stub-skill-marketplace")).toBeInTheDocument()
  })
})
