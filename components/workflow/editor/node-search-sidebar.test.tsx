/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePalettePreferencesStore } from "@/stores/workflow"
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { registerPluginI18n, __resetPluginI18nForTesting } from "@/lib/i18n/plugin-i18n-registry"
import { NodeSearchSidebar } from "./node-search-sidebar"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <TooltipProvider>
        <NodeSearchSidebar />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function resetPrefs() {
  act(() => {
    usePalettePreferencesStore.setState({ favoriteNodeKinds: [], recentlyUsedNodeKinds: [] })
  })
}

describe("NodeSearchSidebar", () => {
  beforeEach(resetPrefs)

  it("renders the catalog grouped by category in browse mode", () => {
    mount()
    // Built-in trigger kind chip is present.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual").length).toBeGreaterThan(0)
  })

  it("shows the empty favorites hint until a node is starred", () => {
    mount()
    // The Favorites group renders its empty-state hint (from en.json).
    expect(screen.getByText("No favorites yet — star a node to pin it here.")).toBeInTheDocument()
  })

  it("starring a node pins it into the Favorites group", () => {
    mount()
    // One occurrence (its category) before favoriting.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual")).toHaveLength(1)

    const star = screen.getByTestId("wf-sidebar-fav-trigger.manual")
    act(() => {
      fireEvent.click(star)
    })

    expect(usePalettePreferencesStore.getState().favoriteNodeKinds).toContain("trigger.manual")
    // Now it appears twice: once in Favorites, once in its category.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual")).toHaveLength(2)
  })

  it("surfaces recently-used kinds in the Recent group", () => {
    act(() => {
      usePalettePreferencesStore.getState().recordUsed("ai.prompt")
    })
    mount()
    const recentHeader = screen.getByText("Recently used")
    expect(recentHeader).toBeInTheDocument()
    expect(screen.getAllByTestId("wf-sidebar-ai.prompt").length).toBeGreaterThanOrEqual(2)
  })

  it("hides favorites/recent and shows flat results while searching", () => {
    act(() => {
      usePalettePreferencesStore.getState().toggleFavorite("trigger.manual")
    })
    mount()
    const search = screen.getByPlaceholderText("Search nodes…")
    act(() => {
      fireEvent.change(search, { target: { value: "manual" } })
    })
    // Favorites group header is gone in search mode.
    expect(screen.queryByText("Favorites")).toBeNull()
    // The matching node still shows (flat results).
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual").length).toBeGreaterThan(0)
  })

  it("ignores favorites for kinds that are not in the catalog", () => {
    act(() => {
      usePalettePreferencesStore.setState({ favoriteNodeKinds: ["plugin.ghost.kind"] })
    })
    mount()
    // Stale kind is filtered out → favorites group stays in its empty state.
    expect(screen.getByText("No favorites yet — star a node to pin it here.")).toBeInTheDocument()
  })

  describe("plugin node localization", () => {
    afterEach(() => {
      act(() => {
        __resetPluginCatalogForTesting()
        __resetPluginI18nForTesting()
      })
    })

    function registerDemoNode() {
      act(() => {
        addPluginCatalogEntry({
          kind: "demo.action.format" as never,
          category: "plugin",
          label: "Format Rust",
          description: "Run rustfmt on a Rust source string",
          iconName: "Wand",
          keywords: [],
          pluginId: "demo",
        })
      })
    }

    // Mirrors what the plugin manager does on enable: register a plugin's
    // `manifest.i18n` strings under the absolute `plugin.<id>.…` namespace.
    function registerDemoTranslations() {
      act(() => {
        registerPluginI18n({
          pluginId: "demo",
          messages: {
            en: {
              "plugin.demo.workflow.nodes.action.format.label": "格式化 Rust",
              "plugin.demo.workflow.nodes.action.format.description": "运行 rustfmt",
            },
          },
        })
      })
    }

    it("renders the plugin author's raw label when no translation is registered", () => {
      registerDemoNode()
      mount()
      const chip = screen.getByTestId("wf-sidebar-demo.action.format")
      expect(chip).toHaveTextContent("Format Rust")
    })

    it("renders the translated label from the plugin's i18n overlay namespace", () => {
      registerDemoNode()
      registerDemoTranslations()
      mount()
      const chip = screen.getByTestId("wf-sidebar-demo.action.format")
      expect(chip).toHaveTextContent("格式化 Rust")
      expect(chip).not.toHaveTextContent("Format Rust")
    })

    it("finds a plugin node by its translated label in search mode", () => {
      registerDemoNode()
      registerDemoTranslations()
      mount()
      const search = screen.getByPlaceholderText("Search nodes…")
      act(() => {
        fireEvent.change(search, { target: { value: "格式化" } })
      })
      expect(screen.getByTestId("wf-sidebar-demo.action.format")).toBeInTheDocument()
    })
  })

  it("splits the oversized actions group into palette sections", () => {
    // 124 of the 177 built-in entries share the `action` category, so before
    // this the agent node sat in one flat list below every scheduler, git and
    // mobile node.
    mount()
    expect(screen.getByTestId("wf-palette-section-agents")).toBeInTheDocument()
    expect(screen.getByTestId("wf-palette-section-plans")).toBeInTheDocument()
    // Triggers stay flat: that group already reads as one list.
    expect(screen.queryByTestId("wf-palette-section-other")).toBeNull()
  })
})
