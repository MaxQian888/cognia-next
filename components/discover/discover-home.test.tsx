/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DiscoverHomeResult } from "@/hooks/discover/use-discover-home"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

import { DiscoverHome } from "./discover-home"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && Object.keys(vars).length > 0) return key + ":" + JSON.stringify(vars)
    return key
  },
  useLocale: () => "en",
}))

// Stub the grid (used only for the searching branch) + the item card so the
// test focuses on the home layout and doesn't need the settings store.
jest.mock("@/components/discover/discover-grid", () => ({
  DiscoverGrid: ({ items }: { items: DiscoverItem[] }) => (
    <div data-testid="stub-grid">{items.length} results</div>
  ),
}))
jest.mock("@/components/discover/discover-item-card", () => ({
  DiscoverItemCard: ({ item, onSelect }: { item: DiscoverItem; onSelect: () => void }) => (
    <button data-testid={`stub-card-${item.kind}-${item.id}`} onClick={onSelect}>
      {item.id}
    </button>
  ),
}))

const character = (id: string): DiscoverItem => ({
  kind: "character",
  id,
  data: { id, name: id } as never,
})

const baseHome = (over: Partial<DiscoverHomeResult> = {}): DiscoverHomeResult => ({
  featured: [],
  recent: [],
  sections: [],
  items: [],
  searchResults: [],
  searching: false,
  loading: false,
  ...over,
})

describe("<DiscoverHome />", () => {
  const noop = jest.fn()

  it("renders the search grid when searching", () => {
    render(
      <DiscoverHome
        home={baseHome({ searching: true, searchResults: [character("c1")] })}
        query="c"
        selectedItemId={null}
        onSelectItem={noop}
        onSelectCategory={noop}
      />
    )
    expect(screen.getByTestId("discover-home-search")).toBeInTheDocument()
    expect(screen.getByTestId("stub-grid")).toHaveTextContent("1 results")
  })

  it("renders skeletons while loading", () => {
    render(
      <DiscoverHome
        home={baseHome({ loading: true })}
        query=""
        selectedItemId={null}
        onSelectItem={noop}
        onSelectCategory={noop}
      />
    )
    expect(screen.getByTestId("discover-home-loading")).toBeInTheDocument()
  })

  it("renders the empty state when there is no content", () => {
    render(
      <DiscoverHome
        home={baseHome()}
        query=""
        selectedItemId={null}
        onSelectItem={noop}
        onSelectCategory={noop}
      />
    )
    expect(screen.getByTestId("discover-home-empty")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-discover")).toBeInTheDocument()
  })

  it("renders featured + recent + section strips", () => {
    render(
      <DiscoverHome
        home={baseHome({
          featured: [character("f1")],
          recent: [character("r1")],
          sections: [
            { category: "characters", group: "agents", items: [character("c1")], total: 5 },
          ],
        })}
        query=""
        selectedItemId={null}
        onSelectItem={noop}
        onSelectCategory={noop}
      />
    )
    expect(screen.getByTestId("discover-home-featured")).toBeInTheDocument()
    expect(screen.getByTestId("discover-home-recent")).toBeInTheDocument()
    expect(screen.getByTestId("discover-home-section-characters")).toBeInTheDocument()
    expect(screen.getByTestId("stub-card-character-c1")).toBeInTheDocument()
  })

  it("fires onSelectCategory from a section's View all affordance", async () => {
    const onSelectCategory = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverHome
        home={baseHome({
          sections: [
            { category: "characters", group: "agents", items: [character("c1")], total: 5 },
          ],
        })}
        query=""
        selectedItemId={null}
        onSelectItem={noop}
        onSelectCategory={onSelectCategory}
      />
    )
    await user.click(screen.getByTestId("discover-home-viewall-characters"))
    expect(onSelectCategory).toHaveBeenCalledWith("characters")
  })

  it("fires onSelectItem when a strip card is clicked", async () => {
    const onSelectItem = jest.fn()
    const user = userEvent.setup()
    render(
      <DiscoverHome
        home={baseHome({ featured: [character("f1")] })}
        query=""
        selectedItemId={null}
        onSelectItem={onSelectItem}
        onSelectCategory={noop}
      />
    )
    await user.click(screen.getByTestId("stub-card-character-f1"))
    expect(onSelectItem).toHaveBeenCalledWith("f1")
  })
})
