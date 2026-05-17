/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// Radix DropdownMenu uses a portal + pointer-event flow that's brittle in
// jsdom. Match the project convention from
// `provider/openrouter-key-management.test.tsx` and replace it with thin
// pass-throughs. `onSelect` is forwarded to the underlying button's
// `onClick` so fireEvent.click invokes the production handler unchanged.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    "data-testid"?: string
    variant?: string
  }) => (
    <button onClick={() => onSelect?.()} data-testid={testId}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { SavedThemesRail, type SavedThemesRailLabels } from "./saved-themes-rail"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"

const labels: SavedThemesRailLabels = {
  title: "Saved themes",
  empty: "No themes",
  startNew: "Start new",
  activate: "Activate",
  deactivate: "Deactivate",
  duplicate: "Duplicate",
  export: "Export",
  delete: "Delete",
  more: "More",
  lightSwatchAria: "Light variant",
  darkSwatchAria: "Dark variant",
  activeBadgeAria: "Active",
}

function makeTokens(bg: string, primary: string): ThemeColors {
  return {
    primary,
    primaryForeground: "#fff",
    secondary: "#888",
    secondaryForeground: "#fff",
    accent: primary,
    accentForeground: "#fff",
    background: bg,
    foreground: "#000",
    muted: "#eee",
    mutedForeground: "#666",
    card: bg,
    cardForeground: "#000",
    popover: bg,
    popoverForeground: "#000",
    input: "#ddd",
    border: "#ddd",
    ring: primary,
    destructive: "#f00",
    destructiveForeground: "#fff",
    sidebar: bg,
    sidebarForeground: "#000",
    sidebarPrimary: primary,
    sidebarBorder: "#ddd",
    sidebarPrimaryForeground: "#fff",
    sidebarAccent: "#eee",
    sidebarAccentForeground: "#000",
    sidebarRing: primary,
  }
}

const dualVariantTheme: CustomTheme = {
  id: "dual-1",
  name: "Dual",
  baseVariant: "light",
  tokens: {
    light: makeTokens("#ffffff", "#0066ff"),
    dark: makeTokens("#000000", "#66aaff"),
  },
}

const legacyDarkTheme: CustomTheme = {
  id: "legacy-1",
  name: "Legacy Dark",
  isDark: true,
  colors: makeTokens("#101010", "#ff5500"),
}

function noopHandlers() {
  return {
    onSelect: jest.fn(),
    onActivate: jest.fn(),
    onDeactivate: jest.fn(),
    onDuplicate: jest.fn(),
    onExport: jest.fn(),
    onDelete: jest.fn(),
    onNew: jest.fn(),
  }
}

describe("<SavedThemesRail />", () => {
  it("renders the empty state with a Start new button that fires onNew", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail themes={[]} activeId={null} editingId={undefined} labels={labels} {...h} />
    )
    expect(screen.getByText("No themes")).toBeInTheDocument()
    const [headerNew, bodyNew] = screen.getAllByRole("button", { name: /Start new/i })
    expect(headerNew).toBeInTheDocument()
    fireEvent.click(bodyNew)
    expect(h.onNew).toHaveBeenCalledTimes(1)
  })

  it("renders one item per theme with the dual-swatch slot", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme, legacyDarkTheme]}
        activeId={null}
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    expect(screen.getByTestId("saved-theme-dual-1")).toBeInTheDocument()
    expect(screen.getByTestId("saved-theme-legacy-1")).toBeInTheDocument()
    expect(screen.getByTestId("saved-theme-dual-1-swatch")).toBeInTheDocument()
  })

  it("marks the active theme and hides the active icon on others", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme, legacyDarkTheme]}
        activeId="dual-1"
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    expect(screen.getByTestId("saved-theme-dual-1-active")).toBeInTheDocument()
    expect(screen.queryByTestId("saved-theme-legacy-1-active")).not.toBeInTheDocument()
  })

  it("marks the editing theme with data-editing", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId={null}
        editingId="dual-1"
        labels={labels}
        {...h}
      />
    )
    expect(screen.getByTestId("saved-theme-dual-1")).toHaveAttribute("data-editing", "true")
  })

  it("fires onSelect with the full theme when the row body is clicked", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId={null}
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Dual/ }))
    expect(h.onSelect).toHaveBeenCalledWith(dualVariantTheme)
  })

  it("shows Activate when the theme is not active, Deactivate otherwise", () => {
    const h = noopHandlers()
    const { rerender } = render(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId={null}
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    expect(screen.getByTestId("saved-theme-dual-1-activate")).toBeInTheDocument()
    expect(screen.queryByTestId("saved-theme-dual-1-deactivate")).not.toBeInTheDocument()

    rerender(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId="dual-1"
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    expect(screen.getByTestId("saved-theme-dual-1-deactivate")).toBeInTheDocument()
    expect(screen.queryByTestId("saved-theme-dual-1-activate")).not.toBeInTheDocument()
  })

  it("fires Activate / Duplicate / Export / Delete callbacks from the menu", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId={null}
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    fireEvent.click(screen.getByTestId("saved-theme-dual-1-activate"))
    expect(h.onActivate).toHaveBeenCalledWith("dual-1")

    fireEvent.click(screen.getByTestId("saved-theme-dual-1-duplicate"))
    expect(h.onDuplicate).toHaveBeenCalledWith(dualVariantTheme)

    fireEvent.click(screen.getByTestId("saved-theme-dual-1-export"))
    expect(h.onExport).toHaveBeenCalledWith(dualVariantTheme)

    fireEvent.click(screen.getByTestId("saved-theme-dual-1-delete"))
    expect(h.onDelete).toHaveBeenCalledWith("dual-1")
  })

  it("fires onDeactivate (no args) when the active row's menu item is clicked", () => {
    const h = noopHandlers()
    render(
      <SavedThemesRail
        themes={[dualVariantTheme]}
        activeId="dual-1"
        editingId={undefined}
        labels={labels}
        {...h}
      />
    )
    fireEvent.click(screen.getByTestId("saved-theme-dual-1-deactivate"))
    expect(h.onDeactivate).toHaveBeenCalledWith()
  })
})
