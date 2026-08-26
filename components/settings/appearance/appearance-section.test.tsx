/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const replace = jest.fn()
let searchString = ""
let hasPluginExtensions = false

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchString),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// Stub out every panel — we only need to assert the right one is rendered.
jest.mock("./tabs/theme-tab", () => ({ ThemeTab: () => <div data-testid="tab-theme" /> }))
jest.mock("./tabs/auto-mode-tab", () => ({ AutoModeTab: () => <div data-testid="tab-auto" /> }))
jest.mock("./tabs/wallpaper-tab", () => ({
  WallpaperTab: () => <div data-testid="tab-wallpaper" />,
}))
jest.mock("./tabs/custom-theme-tab", () => ({
  CustomThemeTab: () => <div data-testid="tab-custom" />,
}))
jest.mock("./tabs/components-tab", () => ({
  ComponentsTab: () => <div data-testid="tab-components" />,
}))
jest.mock("./tabs/a11y-tab", () => ({ A11yTab: () => <div data-testid="tab-a11y" /> }))
jest.mock("./tabs/advanced-tab", () => ({ AdvancedTab: () => <div data-testid="tab-advanced" /> }))
// The two merged panels stub at the panel boundary, not at the tabs they wrap.
jest.mock("./panels/library-panel", () => ({
  AppearanceLibraryPanel: () => <div data-testid="panel-library" />,
}))
jest.mock("./panels/typography-panel", () => ({
  AppearanceTypographyPanel: () => <div data-testid="panel-typography" />,
}))
jest.mock("../personalization-card", () => ({
  PersonalizationCard: () => <div data-testid="personalization-card-stub" />,
}))
jest.mock("./components/appearance-preview", () => ({
  AppearancePreview: () => <div data-testid="appearance-preview-stub" />,
}))
jest.mock("./components/appearance-config-toolbar", () => ({
  AppearanceConfigToolbar: () => <div data-testid="io-toolbar-stub" />,
}))
// jsdom measures every box at 0, which the section reads as "not measured yet"
// and treats as wide. Driving the width from here is what lets the narrow case
// be asserted at all.
let detailWidth = 0
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => detailWidth,
}))
// `usePluginSlotHasExtensions` lives in the same module as the slot, so the
// factory has to provide both or the section crashes calling undefined.
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => <div data-testid="plugin-slot" />,
  usePluginSlotHasExtensions: () => hasPluginExtensions,
}))

import { AppearanceSection } from "./appearance-section"

beforeEach(() => {
  replace.mockClear()
  detailWidth = 0
  searchString = ""
  hasPluginExtensions = false
})

describe("AppearanceSection", () => {
  describe("panel resolution", () => {
    it("defaults to the theme panel when the URL has no appearanceTab", () => {
      render(<AppearanceSection />)
      expect(screen.getByTestId("tab-theme")).toBeInTheDocument()
    })

    it("respects the appearanceTab URL param", () => {
      searchString = "?appearanceTab=wallpaper"
      render(<AppearanceSection />)
      expect(screen.getByTestId("tab-wallpaper")).toBeInTheDocument()
    })

    it.each([
      ["auto", "tab-auto"],
      ["custom", "tab-custom"],
      ["components", "tab-components"],
      ["a11y", "tab-a11y"],
      ["advanced", "tab-advanced"],
      ["library", "panel-library"],
      ["typography", "panel-typography"],
    ])("renders the %s panel when selected", (panel, testId) => {
      searchString = `?appearanceTab=${panel}`
      render(<AppearanceSection />)
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    })

    it("falls back to the theme panel on an unknown id", () => {
      searchString = "?appearanceTab=garbage"
      render(<AppearanceSection />)
      expect(screen.getByTestId("tab-theme")).toBeInTheDocument()
    })

    // Personalization used to hang off the section bottom with no nav entry;
    // it is a panel now, so it is no longer always mounted.
    it("renders personalization on its own panel", () => {
      searchString = "?appearanceTab=personalization"
      render(<AppearanceSection />)
      expect(screen.getByTestId("personalization-card-stub")).toBeInTheDocument()
    })

    it("no longer mounts personalization under every panel", () => {
      render(<AppearanceSection />)
      expect(screen.queryByTestId("personalization-card-stub")).not.toBeInTheDocument()
    })
  })

  // Links minted before the 11-tab strip was merged down to 10 entries.
  describe("legacy deep links", () => {
    it.each([
      ["themePack", "panel-library"],
      ["import", "panel-library"],
      ["layout", "panel-typography"],
    ])("resolves ?appearanceTab=%s to the merged panel", (raw, testId) => {
      searchString = `?appearanceTab=${raw}`
      render(<AppearanceSection />)
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    })
  })

  describe("navigation", () => {
    it("renders the three group headers", () => {
      render(<AppearanceSection />)
      expect(screen.getAllByTestId("appearance-nav-group-themeGroup")).not.toHaveLength(0)
      expect(screen.getAllByTestId("appearance-nav-group-interfaceGroup")).not.toHaveLength(0)
      expect(screen.getAllByTestId("appearance-nav-group-advancedGroup")).not.toHaveLength(0)
    })

    it("updates the URL when a nav entry is clicked", async () => {
      const user = userEvent.setup()
      render(<AppearanceSection />)
      // The nav renders twice (desktop rail + mobile sheet); either drives it.
      await user.click(screen.getAllByTestId("appearance-nav-item-library")[0])
      expect(replace).toHaveBeenCalledWith("?appearanceTab=library", { scroll: false })
    })

    it("offers a sheet trigger for narrow viewports", () => {
      render(<AppearanceSection />)
      expect(screen.getByTestId("appearance-mobile-nav-trigger")).toBeInTheDocument()
    })
  })

  describe("plugins entry", () => {
    it("is hidden while nothing contributes to the slot", () => {
      render(<AppearanceSection />)
      expect(screen.queryByTestId("appearance-nav-item-plugins")).not.toBeInTheDocument()
    })

    it("appears once a plugin contributes", () => {
      hasPluginExtensions = true
      render(<AppearanceSection />)
      expect(screen.getAllByTestId("appearance-nav-item-plugins")).not.toHaveLength(0)
    })

    it("renders the slot on its own panel", () => {
      hasPluginExtensions = true
      searchString = "?appearanceTab=plugins"
      render(<AppearanceSection />)
      expect(screen.getByTestId("plugin-slot")).toBeInTheDocument()
    })

    // A stale link must not land on an empty panel.
    it("falls back to theme when linked to with no contributions", () => {
      searchString = "?appearanceTab=plugins"
      render(<AppearanceSection />)
      expect(screen.getByTestId("tab-theme")).toBeInTheDocument()
    })
  })

  // The whole point of the refactor: the custom-theme editor no longer ships
  // a second preview beside this one.
  describe("preview", () => {
    it.each(["theme", "custom", "wallpaper", "a11y"])(
      "mounts exactly one preview on the %s panel",
      (panel) => {
        searchString = `?appearanceTab=${panel}`
        render(<AppearanceSection />)
        expect(screen.getAllByTestId("appearance-preview-stub")).toHaveLength(1)
      }
    )

    it("starts collapsed once the detail column is too narrow to spare the height", () => {
      // In a ~400px column the preview is a ~300px-tall card sitting between
      // the user and the controls they opened the panel to change.
      detailWidth = 400
      render(<AppearanceSection />)
      expect(screen.queryByTestId("appearance-preview-stub")).not.toBeInTheDocument()
      expect(screen.getByTestId("appearance-panel-title")).toBeInTheDocument()
    })

    it("starts open in a wide detail column", () => {
      detailWidth = 700
      render(<AppearanceSection />)
      expect(screen.getByTestId("appearance-preview-stub")).toBeInTheDocument()
    })

    it("lets an explicit toggle override the narrow default", async () => {
      detailWidth = 400
      const user = userEvent.setup()
      render(<AppearanceSection />)
      expect(screen.queryByTestId("appearance-preview-stub")).not.toBeInTheDocument()

      await user.click(screen.getByTestId("appearance-preview-toggle"))
      expect(screen.getByTestId("appearance-preview-stub")).toBeInTheDocument()
    })

    it("collapses the preview without taking the panel identity with it", async () => {
      const user = userEvent.setup()
      render(<AppearanceSection />)
      await user.click(screen.getByTestId("appearance-preview-toggle"))
      expect(screen.queryByTestId("appearance-preview-stub")).not.toBeInTheDocument()
      expect(screen.getByTestId("appearance-panel-title")).toBeInTheDocument()
    })
  })

  // Before this, the pane opened with a bare "Live preview" strip and the only
  // thing naming the current panel on desktop was the highlight in the nav.
  describe("detail header", () => {
    it("names the active panel", () => {
      searchString = "?appearanceTab=cursor"
      render(<AppearanceSection />)
      expect(screen.getByTestId("appearance-panel-title")).toHaveTextContent(
        "nav.items.cursor.label"
      )
    })

    it("follows a legacy deep link to the panel it resolves to", () => {
      searchString = "?appearanceTab=themePack"
      render(<AppearanceSection />)
      expect(screen.getByTestId("appearance-panel-title")).toHaveTextContent(
        "nav.items.library.label"
      )
    })

    // The scroll container outlives the panel it holds, so without an explicit
    // reset you land halfway down a panel you have never scrolled.
    it("scrolls the panel body back to the top when the panel changes", () => {
      const setScrollTop = jest.fn()
      const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get: () => 0,
        set: setScrollTop,
      })
      try {
        const { rerender } = render(<AppearanceSection />)
        setScrollTop.mockClear()
        searchString = "?appearanceTab=a11y"
        rerender(<AppearanceSection />)
        expect(setScrollTop).toHaveBeenCalledWith(0)
      } finally {
        if (original) Object.defineProperty(Element.prototype, "scrollTop", original)
      }
    })

    it("does not reset the scroll on an unrelated re-render", () => {
      const setScrollTop = jest.fn()
      const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get: () => 0,
        set: setScrollTop,
      })
      try {
        const { rerender } = render(<AppearanceSection />)
        setScrollTop.mockClear()
        rerender(<AppearanceSection />)
        expect(setScrollTop).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(Element.prototype, "scrollTop", original)
      }
    })
  })

  it("does not render an inline reset button (the shell owns section reset)", () => {
    render(<AppearanceSection />)
    expect(screen.queryByRole("button", { name: "reset.button" })).not.toBeInTheDocument()
  })
})
