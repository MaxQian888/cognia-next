/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@cognia/agent-config-types"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

// Every `useDiscoverQuery` call is recorded, so the tests can pin that the
// cross-kind fallback only subscribes while something actually needs it.
const queryCalls: Array<{ view: string; keys: string[] }> = []
let catalog: DiscoverItem[] = []
let fallbackLoading = false
jest.mock("@/hooks/discover/use-discover-query", () => ({
  useDiscoverQuery: (view: string, _query: string, opts?: { favoriteKeys?: Set<string> }) => {
    const keys = [...(opts?.favoriteKeys ?? new Set<string>())]
    queryCalls.push({ view, keys })
    if (view !== "favorites") return { items: [], loading: false }
    return {
      items: catalog.filter((item) => keys.includes(`${item.kind}:${item.id}`)),
      loading: fallbackLoading,
    }
  },
}))

// The real inspector is covered by its own suite; here it only has to prove
// which item the sheet resolved and that it is the dialog's title.
jest.mock("@/components/discover/discover-inspector", () => {
  const { SheetTitle } = jest.requireActual("@/components/ui/sheet")
  return {
    DiscoverInspector: ({
      itemId,
      items,
      onClose,
      presentation,
    }: {
      itemId: string
      items: DiscoverItem[]
      onClose: () => void
      presentation: string
    }) => (
      <section
        data-testid={`inspector-${items[0]?.kind}-${itemId}`}
        data-presentation={presentation}
      >
        <SheetTitle>{`title:${itemId}`}</SheetTitle>
        <button type="button" onClick={onClose}>
          inspector-close
        </button>
      </section>
    ),
  }
})

import {
  DiscoverItemSheet,
  discoverItemKeysForId,
  type DiscoverItemSheetProps,
} from "./discover-item-sheet"

const alpha: DiscoverItem = {
  kind: "character",
  id: "char_alpha",
  data: { id: "char_alpha", name: "Alpha" } as unknown as Character,
}
const lark: DiscoverItem = {
  kind: "connector",
  id: "lark",
  data: { type: "lark", status: "stable" } as never,
}

function renderSheet(props: Partial<DiscoverItemSheetProps> = {}) {
  const merged: DiscoverItemSheetProps = {
    itemId: null,
    items: [],
    loading: false,
    category: "foryou",
    onClose: jest.fn(),
    ...props,
  }
  return { ...render(<DiscoverItemSheet {...merged} />), props: merged }
}

beforeEach(() => {
  queryCalls.length = 0
  catalog = []
  fallbackLoading = false
})

describe("discoverItemKeysForId", () => {
  it("builds one favorite key per Discover kind", () => {
    const keys = discoverItemKeysForId("x")
    expect(keys.has("character:x")).toBe(true)
    expect(keys.has("connector:x")).toBe(true)
    expect(keys.has("subagent:x")).toBe(true)
    expect(keys.size).toBe(18)
  })
})

describe("<DiscoverItemSheet />", () => {
  it("stays closed without an item and subscribes to nothing", () => {
    renderSheet()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    // For You is not materialized by the query hook, so it is the inert view.
    expect(queryCalls.every((call) => call.view === "foryou" && call.keys.length === 0)).toBe(true)
  })

  it("opens on the item from the visible list, titled by it", () => {
    renderSheet({ itemId: "char_alpha", items: [alpha] })
    const dialog = screen.getByRole("dialog", { name: "title:char_alpha" })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByTestId("inspector-character-char_alpha")).toHaveAttribute(
      "data-presentation",
      "sheet"
    )
    expect(queryCalls.some((call) => call.view === "favorites")).toBe(false)
  })

  it("waits for the visible list before falling back", () => {
    renderSheet({ itemId: "lark", items: [], loading: true })
    expect(screen.getByTestId("discover-item-sheet-loading")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Loading details" })).toBeInTheDocument()
    expect(queryCalls.some((call) => call.view === "favorites")).toBe(false)
  })

  it("resolves a cold deep link the current view does not list, across every kind", () => {
    catalog = [alpha, lark]
    renderSheet({ itemId: "lark", items: [alpha], loading: false })
    expect(screen.getByTestId("inspector-connector-lark")).toBeInTheDocument()
    const fallbackCall = queryCalls.find((call) => call.view === "favorites")
    expect(fallbackCall?.keys).toEqual(expect.arrayContaining(["connector:lark", "character:lark"]))
  })

  it("shows the fallback's loading state while it reads", () => {
    fallbackLoading = true
    renderSheet({ itemId: "lark", items: [], loading: false })
    expect(screen.getByTestId("discover-item-sheet-loading")).toBeInTheDocument()
  })

  it("says the item is missing when no kind carries the id", () => {
    catalog = [alpha]
    renderSheet({ itemId: "ghost", items: [alpha], loading: false })
    expect(screen.getByTestId("discover-item-sheet-missing")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Item not found" })).toBeInTheDocument()
  })

  it("closes through onClose from the missing state's button", async () => {
    const user = userEvent.setup()
    const { props } = renderSheet({ itemId: "ghost", items: [], loading: false })
    await user.click(screen.getByTestId("discover-item-sheet-close"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("routes Escape through onClose so the URL is the only open state", async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderSheet({ itemId: "char_alpha", items: [alpha] })
    await user.keyboard("{Escape}")
    expect(props.onClose).toHaveBeenCalledTimes(1)
    // Still open until the URL says otherwise.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    rerender(<DiscoverItemSheet {...props} itemId={null} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("forwards the inspector's own close button", async () => {
    const user = userEvent.setup()
    const { props } = renderSheet({ itemId: "char_alpha", items: [alpha] })
    await user.click(screen.getByRole("button", { name: "inspector-close" }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("docks to the bottom on the compact body", () => {
    renderSheet({ itemId: "char_alpha", items: [alpha], side: "bottom" })
    expect(screen.getByTestId("discover-item-sheet").className).toContain("max-h-[85vh]")
  })
})
