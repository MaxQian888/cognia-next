/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import { render, screen } from "@testing-library/react"
import { SkillMarketplaceEmpty } from "./skill-marketplace-empty"

describe("SkillMarketplaceEmpty", () => {
  it("renders all teaser cards", () => {
    render(<SkillMarketplaceEmpty />)
    expect(screen.getByText("Code Reviewer")).toBeInTheDocument()
    expect(screen.getByText("Meeting Notetaker")).toBeInTheDocument()
    expect(screen.getByText("SQL Explainer")).toBeInTheDocument()
    expect(screen.getByText("Email Rewriter")).toBeInTheDocument()
  })

  it("renders a settings CTA pointing at the marketplace settings", () => {
    render(<SkillMarketplaceEmpty />)
    const link = screen.getByRole("link", { name: /configure/i })
    expect(link).toHaveAttribute("href", expect.stringContaining("marketplace"))
  })
})
