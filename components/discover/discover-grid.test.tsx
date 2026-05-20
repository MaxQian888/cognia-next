/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@/lib/claude/types"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

import { DiscoverGrid } from "./discover-grid"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) {
      return key + ":" + JSON.stringify(vars)
    }
    return key
  },
  useLocale: () => "en",
}))

const mkCharacter = (id: string, name: string): DiscoverItem => ({
  kind: "character",
  id,
  data: {
    id,
    name,
    description: "",
    systemPrompt: "",
    avatarColor: "#abc",
    avatarEmoji: "🐙",
    isBuiltIn: false,
  } as unknown as Character,
})

describe("<DiscoverGrid />", () => {
  it("renders a loading state when loading=true", () => {
    render(
      <DiscoverGrid
        category="characters"
        items={[]}
        loading
        query=""
        selectedItemId={null}
        onSelectItem={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-grid-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("discover-grid-empty")).not.toBeInTheDocument()
  })

  it("renders an empty state with the category-specific key when no items", () => {
    render(
      <DiscoverGrid
        category="characters"
        items={[]}
        loading={false}
        query=""
        selectedItemId={null}
        onSelectItem={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-grid-empty")).toBeInTheDocument()
    expect(screen.getByText("emptyCharacters")).toBeInTheDocument()
  })

  it("renders the search-empty message when query is non-empty and no items", () => {
    render(
      <DiscoverGrid
        category="characters"
        items={[]}
        loading={false}
        query="zzzz"
        selectedItemId={null}
        onSelectItem={jest.fn()}
      />
    )
    // Format from the mock: `emptyFiltered:{"query":"zzzz"}`.
    expect(screen.getByText(/emptyFiltered.*zzzz/)).toBeInTheDocument()
  })

  it("renders one DiscoverItemCard per item with a stable list key", () => {
    render(
      <DiscoverGrid
        category="characters"
        items={[mkCharacter("c1", "Alpha"), mkCharacter("c2", "Beta")]}
        loading={false}
        query=""
        selectedItemId={null}
        onSelectItem={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-grid-characters")).toBeInTheDocument()
    expect(screen.getByTestId("discover-item-character-c1")).toBeInTheDocument()
    expect(screen.getByTestId("discover-item-character-c2")).toBeInTheDocument()
  })

  it("marks the card matching selectedItemId as pressed", () => {
    render(
      <DiscoverGrid
        category="characters"
        items={[mkCharacter("c1", "Alpha"), mkCharacter("c2", "Beta")]}
        loading={false}
        query=""
        selectedItemId="c2"
        onSelectItem={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-item-character-c1")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(screen.getByTestId("discover-item-character-c2")).toHaveAttribute("aria-pressed", "true")
  })

  it("calls onSelectItem with the clicked card's id", async () => {
    const onSelectItem = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverGrid
        category="characters"
        items={[mkCharacter("c1", "Alpha"), mkCharacter("c2", "Beta")]}
        loading={false}
        query=""
        selectedItemId={null}
        onSelectItem={onSelectItem}
      />
    )
    await user.click(screen.getByTestId("discover-item-character-c2"))
    expect(onSelectItem).toHaveBeenCalledWith("c2")
  })
})
