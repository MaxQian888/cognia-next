/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LucideIcon } from "lucide-react"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { MoreMenuContent } from "./more-menu"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import type { SidebarNavCategory } from "@/types/shell/sidebar"

const Icon = (() => null) as unknown as LucideIcon

function item(id: string, category: SidebarNavCategory, aliasKey?: string): SidebarCatalogItem {
  return { id, route: `/${id}`, i18nKey: id, group: "auxiliary", category, aliasKey, Icon }
}

const ITEMS: SidebarCatalogItem[] = [
  item("plugins", "explore"),
  item("skills", "explore"),
  item("agent-runs", "agents"),
  item("bots", "agents"),
  item("workspace", "spaces"),
  item("memory", "insights"),
  item("servers", "system"),
  item("devices", "system", "devices"),
  item("me", "you"),
]

function renderMenu(overrides: Partial<Parameters<typeof MoreMenuContent>[0]> = {}) {
  const props = {
    items: ITEMS,
    isActive: (route: string) => route === "/plugins",
    badges: {} as Record<string, number>,
    onOpen: jest.fn(),
    onPin: jest.fn(),
    onHide: jest.fn(),
    onCustomize: jest.fn(),
    testIdPrefix: "more",
    ...overrides,
  }
  render(<MoreMenuContent {...props} />)
  return props
}

describe("MoreMenuContent", () => {
  it("renders items under their category sections, in canonical order", () => {
    renderMenu()
    const labels = screen.getAllByText(/^categories\./).map((el) => el.textContent)
    expect(labels).toEqual([
      "categories.explore",
      "categories.agents",
      "categories.spaces",
      "categories.insights",
      "categories.system",
      "categories.you",
    ])
    expect(screen.getByTestId("more-item-plugins")).toBeInTheDocument()
    expect(screen.getByTestId("more-item-me")).toBeInTheDocument()
  })

  it("drops empty sections and filters by label, id, route and alias", async () => {
    const user = userEvent.setup()
    renderMenu()
    const filter = screen.getByTestId("more-filter")

    await user.type(filter, "agent")
    expect(screen.getByTestId("more-item-agent-runs")).toBeInTheDocument()
    expect(screen.queryByTestId("more-item-plugins")).not.toBeInTheDocument()
    expect(screen.queryByText("categories.spaces")).not.toBeInTheDocument()

    // aliasKey terms resolve too ("aliases.devices" under the mocked t).
    await user.clear(filter)
    await user.type(filter, "aliases.devices")
    expect(screen.getByTestId("more-item-devices")).toBeInTheDocument()
  })

  it("shows an empty state when nothing matches and clears it via the clear button", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.type(screen.getByTestId("more-filter"), "nope")
    expect(screen.getByTestId("more-empty")).toBeInTheDocument()
    await user.click(screen.getByTestId("more-filter-clear"))
    expect(screen.getByTestId("more-item-plugins")).toBeInTheDocument()
  })

  it("pins without opening, opens without pinning, and labels Customize without a bare number", async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByTestId("more-pin-skills"))
    expect(props.onPin).toHaveBeenCalledWith("skills")
    expect(props.onOpen).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("more-item-memory"))
    expect(props.onOpen).toHaveBeenCalledWith("/memory")

    await user.click(screen.getByTestId("more-customize"))
    expect(props.onCustomize).toHaveBeenCalled()
    // The count that used to sit here read as "N of what?"; the row says
    // what it does and nothing else.
    expect(screen.getByTestId("more-customize")).toHaveTextContent(/^customize\.title$/)
  })

  it("hides an entry from its own row without opening or pinning it", async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    const hide = screen.getByTestId("more-hide-skills")
    expect(hide).toHaveAccessibleName('customize.hideNamed:{"item":"skills"}')
    await user.click(hide)
    expect(props.onHide).toHaveBeenCalledWith("skills")
    expect(props.onPin).not.toHaveBeenCalled()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it("names each pin button after its entry", () => {
    renderMenu()
    expect(screen.getByTestId("more-pin-memory")).toHaveAccessibleName(
      'customize.pinItem:{"item":"memory"}'
    )
  })

  it("marks the active entry as the current page", () => {
    renderMenu()
    expect(screen.getByTestId("more-item-plugins")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("more-item-skills")).not.toHaveAttribute("aria-current")
  })

  it("draws an entry's live count and folds it into the name", () => {
    renderMenu({ badges: { bots: 4, "agent-runs": 120 } })
    expect(screen.getByTestId("more-badge-bots")).toHaveTextContent("4")
    expect(screen.getByTestId("more-badge-agent-runs")).toHaveTextContent("99+")
    expect(screen.getByTestId("more-item-bots")).toHaveAccessibleName(
      'bots, badgeCount:{"count":4}'
    )
    expect(screen.queryByTestId("more-badge-skills")).not.toBeInTheDocument()
  })

  it("opens the first match — as displayed — on Enter in the filter", async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    // "s" matches skills (explore) and servers (system) among others; the
    // first displayed is the explore section's first match.
    await user.type(screen.getByTestId("more-filter"), "s{Enter}")
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith("/plugins")
  })

  it("does nothing on Enter when nothing matches", async () => {
    const user = userEvent.setup()
    const props = renderMenu()
    await user.type(screen.getByTestId("more-filter"), "zzz{Enter}")
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it("walks the entries with the arrow keys and returns to the filter from the top", async () => {
    const user = userEvent.setup()
    renderMenu()
    const filter = screen.getByTestId("more-filter")
    filter.focus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByTestId("more-item-plugins")).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByTestId("more-item-skills")).toHaveFocus()
    await user.keyboard("{End}")
    expect(screen.getByTestId("more-item-me")).toHaveFocus()
    await user.keyboard("{Home}")
    expect(screen.getByTestId("more-item-plugins")).toHaveFocus()
    await user.keyboard("{ArrowUp}")
    expect(filter).toHaveFocus()
  })

  it("keeps the per-item pin button reachable without a hover", () => {
    const props = renderMenu()
    const pin = screen.getByTestId("more-pin-skills")
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.control) {
      expect(pin).toHaveClass(variant)
    }
    // Revealed while focus sits on the row's open button too.
    expect(pin).toHaveClass("group-focus-within:opacity-100")
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(pin).not.toHaveClass(forbidden)
    }
    pin.focus()
    expect(pin).toHaveFocus()
    fireEvent.click(pin)
    expect(props.onPin).toHaveBeenCalledWith("skills")
    expect(props.onOpen).not.toHaveBeenCalled()
  })
})
