/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillMarketplaceListItem } from "./skill-marketplace-list-item"
import type { MarketplaceItem } from "@/lib/skills/marketplace-types"

const item: MarketplaceItem = {
  id: "mp:registry/x",
  source: "registry",
  sourceId: "x",
  name: "X Skill",
  author: "alice",
  category: "custom",
}

describe("SkillMarketplaceListItem", () => {
  it("renders name and author", () => {
    render(
      <SkillMarketplaceListItem item={item} installed={false} active={false} onSelect={jest.fn()} />
    )
    expect(screen.getByText("X Skill")).toBeInTheDocument()
    expect(screen.getByText('byAuthor:{"author":"alice"}')).toBeInTheDocument()
  })

  it("invokes onSelect with the item when clicked", () => {
    const onSelect = jest.fn()
    render(
      <SkillMarketplaceListItem item={item} installed={false} active={false} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText("X Skill"))
    expect(onSelect).toHaveBeenCalledWith(item)
  })

  it("shows the installed indicator when installed", () => {
    render(<SkillMarketplaceListItem item={item} installed active={false} onSelect={jest.fn()} />)
    expect(screen.getByLabelText("installed")).toBeInTheDocument()
  })

  it("applies the active highlight", () => {
    render(<SkillMarketplaceListItem item={item} installed={false} active onSelect={jest.fn()} />)
    expect(screen.getByText("X Skill").closest("button")).toHaveClass("border-l-primary")
  })
})
