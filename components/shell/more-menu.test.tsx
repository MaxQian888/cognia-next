/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { LucideIcon } from "lucide-react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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
    onOpen: jest.fn(),
    onPin: jest.fn(),
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

  it("pins without opening, opens without pinning, and reports the count", async () => {
    const user = userEvent.setup()
    const props = renderMenu()

    await user.click(screen.getByTestId("more-pin-skills"))
    expect(props.onPin).toHaveBeenCalledWith("skills")
    expect(props.onOpen).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("more-item-memory"))
    expect(props.onOpen).toHaveBeenCalledWith("/memory")

    await user.click(screen.getByTestId("more-customize"))
    expect(props.onCustomize).toHaveBeenCalled()
    expect(screen.getByTestId("more-customize")).toHaveTextContent("moreCount")
  })
})
