/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { PresetGrid, type PresetItem } from "./preset-grid"
import type { ThemeColors } from "@/types/plugin/plugin"
import { HOVER_REVEAL_REQUIRED_VARIANTS } from "@/lib/ui/hover-reveal"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (k: string, params?: Record<string, unknown>) => {
    const path = `${ns}.${k}`
    if (params && typeof params.name === "string") return `${path}:${params.name}`
    return path
  },
}))

const COLORS = {
  background: "#111",
  foreground: "#eee",
  primary: "#7c3aed",
  accent: "#22c55e",
} as ThemeColors

const ITEMS: PresetItem[] = [
  { key: "builtin:A", name: "A", colors: COLORS, isDark: true, source: "builtin" },
  {
    key: "imported:i1",
    name: "B",
    colors: COLORS,
    isDark: false,
    source: "imported",
    customThemeId: "ct1",
  },
  {
    key: "plugin:p.x",
    name: "C",
    colors: COLORS,
    isDark: true,
    source: "plugin",
    pluginId: "p",
    pluginName: "Plugin P",
  },
]

describe("PresetGrid", () => {
  it("renders one card per item with name + variant pill", () => {
    render(<PresetGrid items={ITEMS} activeKey={null} onSelect={jest.fn()} />)
    expect(screen.getByText("A")).toBeInTheDocument()
    expect(screen.getByText("B")).toBeInTheDocument()
    expect(screen.getByText("C")).toBeInTheDocument()
  })

  it("shows source badges by source kind", () => {
    render(<PresetGrid items={ITEMS} activeKey={null} onSelect={jest.fn()} />)
    expect(screen.getByText("settings.appearance.vscode.source.builtin")).toBeInTheDocument()
    expect(screen.getByText("settings.appearance.vscode.source.imported")).toBeInTheDocument()
    expect(
      screen.getByText("settings.appearance.vscode.source.fromPlugin:Plugin P")
    ).toBeInTheDocument()
  })

  it("calls onSelect when a card is clicked", () => {
    const onSelect = jest.fn()
    render(<PresetGrid items={ITEMS} activeKey={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByText("A"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "builtin:A" }))
  })

  it("marks the active card via aria-pressed", () => {
    render(<PresetGrid items={ITEMS} activeKey="builtin:A" onSelect={jest.fn()} />)
    const a = screen.getByText("A").closest("button")
    expect(a?.getAttribute("aria-pressed")).toBe("true")
    const b = screen.getByText("B").closest("button")
    expect(b?.getAttribute("aria-pressed")).toBe("false")
  })

  it("says which mode the active card is active for, only on the active card", () => {
    render(
      <PresetGrid
        items={ITEMS}
        activeKey="builtin:A"
        activeStatus={{ kind: "authored", mode: "dark", themeVariant: "dark" }}
        onSelect={jest.fn()}
      />
    )
    const badges = screen.getAllByTestId("active-theme-badge")
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent(
      "settings.appearance.vscode.activeVariant.badge.authored.dark"
    )
    expect(screen.getByText("A").closest("button")).toContainElement(badges[0])
  })

  // The audit case: a dark palette active while the app is light. Intentional
  // dormancy must read as inactive, not as a selection that did not take.
  it("labels an active theme that is dormant in the current mode as inert", () => {
    render(
      <PresetGrid
        items={ITEMS}
        activeKey="builtin:A"
        activeStatus={{ kind: "dormant", mode: "light", themeVariant: "dark" }}
        onSelect={jest.fn()}
      />
    )
    const badge = screen.getByTestId("active-theme-badge")
    expect(badge).toHaveAttribute("data-dormant", "true")
    expect(badge).toHaveTextContent(
      "settings.appearance.vscode.activeVariant.badge.dormantOnly.dark"
    )
  })

  it("falls back to the plain label while no mode has resolved", () => {
    render(<PresetGrid items={ITEMS} activeKey="builtin:A" onSelect={jest.fn()} />)
    expect(screen.getByTestId("active-theme-badge")).toHaveTextContent(
      "settings.appearance.vscode.activeLabel"
    )
  })

  it("keeps every card's actions menu reachable without a hover", () => {
    render(<PresetGrid items={ITEMS} activeKey={null} onSelect={jest.fn()} />)
    const trigger = screen.getByRole("button", { name: "settings.appearance.vscode.menu.aria:A" })
    const wrapper = trigger.parentElement as HTMLElement
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.group) {
      expect(wrapper).toHaveClass(variant)
    }
    expect(wrapper).not.toHaveClass("invisible", "pointer-events-none")
  })

  it("shows the empty-state hint when items is []", () => {
    render(<PresetGrid items={[]} activeKey={null} onSelect={jest.fn()} />)
    expect(screen.getByText("settings.appearance.vscode.noResults")).toBeInTheDocument()
  })
})
