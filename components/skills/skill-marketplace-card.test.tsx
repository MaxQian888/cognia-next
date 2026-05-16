/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import { SkillMarketplaceCard } from "./skill-marketplace-card"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

const item: MarketplaceItem = {
  id: "mp:registry/cite-sources",
  source: "registry",
  sourceId: "cite-sources",
  name: "Cite sources",
  description: "Cite all sources inline.",
  author: "anthropic",
  category: "custom",
  repository: "anthropic-org/very-long-skill-repository-name-that-should-truncate",
  tags: ["citations"],
}

const handlers = {
  onInstall: jest.fn(),
  onUninstall: jest.fn(),
  onOpen: jest.fn(),
}

describe("SkillMarketplaceCard", () => {
  it("renders the skill name and the localized author line", () => {
    render(<SkillMarketplaceCard item={item} installed={false} installing={false} {...handlers} />)
    expect(screen.getByText("Cite sources")).toBeInTheDocument()
    expect(screen.getByText('byAuthor:{"author":"anthropic"}')).toBeInTheDocument()
  })

  it("renders the install action when not installed", () => {
    render(<SkillMarketplaceCard item={item} installed={false} installing={false} {...handlers} />)
    expect(screen.getByText("install")).toBeInTheDocument()
  })

  it("renders the installed indicator when already installed", () => {
    render(<SkillMarketplaceCard item={item} installed installing={false} {...handlers} />)
    expect(screen.getByText("installed")).toBeInTheDocument()
  })

  it("truncates a very long repository slug in the footer link", () => {
    render(<SkillMarketplaceCard item={item} installed={false} installing={false} {...handlers} />)
    const link = screen.getByRole("link", { name: /very-long-skill-repository-name/ })
    // The truncation class is what keeps the layout sane on narrow widths.
    expect(link.className).toMatch(/truncate/)
    expect(link.className).toMatch(/max-w-\[/)
  })
})
