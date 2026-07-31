/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@cognia/agent-config-types"

import { FeaturedCarousel } from "./featured-carousel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      featured: "Featured",
      seeAll: "See all",
    }
    return map[key] ?? key
  },
}))

const make = (id: string, name: string, overrides: Partial<Character> = {}): Character =>
  ({
    id,
    name,
    description: "",
    systemPrompt: "",
    isBuiltIn: true,
    avatarColor: "#abc",
    avatarEmoji: "🐙",
    skills: [],
    ...overrides,
  }) as unknown as Character

describe("<FeaturedCarousel />", () => {
  it("renders nothing when fewer than 3 characters are supplied", () => {
    const { container } = render(
      <FeaturedCarousel characters={[make("a", "Alpha"), make("b", "Beta")]} onSelect={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a tile for each character", () => {
    render(
      <FeaturedCarousel
        characters={[make("a", "Alpha"), make("b", "Beta"), make("c", "Gamma")]}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByTestId("featured-tile-a")).toBeInTheDocument()
    expect(screen.getByTestId("featured-tile-b")).toBeInTheDocument()
    expect(screen.getByTestId("featured-tile-c")).toBeInTheDocument()
    expect(screen.getByTestId("featured-carousel-list").childElementCount).toBe(3)
  })

  it("calls onSelect with the tapped character", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <FeaturedCarousel
        characters={[make("a", "Alpha"), make("b", "Beta"), make("c", "Gamma")]}
        onSelect={onSelect}
      />
    )
    await user.click(screen.getByTestId("featured-tile-b"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe("b")
  })
})
