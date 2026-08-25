/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { AppearanceNav } from "./appearance-nav"
import { APPEARANCE_NAV_GROUPS, type AppearancePanelId } from "../nav-config"

function renderNav(overrides: Partial<React.ComponentProps<typeof AppearanceNav>> = {}) {
  const onSelect = jest.fn()
  const props = {
    groups: APPEARANCE_NAV_GROUPS,
    activeId: "theme" as AppearancePanelId,
    onSelect,
    ...overrides,
  }
  const view = render(<AppearanceNav {...props} />)
  return {
    onSelect,
    /** Re-render with a different active panel, as a URL change would. */
    rerender: (activeId: AppearancePanelId) =>
      view.rerender(<AppearanceNav {...props} activeId={activeId} />),
  }
}

describe("AppearanceNav", () => {
  it("renders every group header", () => {
    renderNav()
    expect(screen.getByTestId("appearance-nav-group-themeGroup")).toBeInTheDocument()
    expect(screen.getByTestId("appearance-nav-group-interfaceGroup")).toBeInTheDocument()
    expect(screen.getByTestId("appearance-nav-group-advancedGroup")).toBeInTheDocument()
  })

  it("renders one entry per panel", () => {
    renderNav()
    expect(screen.getAllByRole("listitem")).toHaveLength(13)
  })

  it("marks the active entry for assistive tech, not just visually", () => {
    renderNav({ activeId: "wallpaper" })
    expect(screen.getByTestId("appearance-nav-item-wallpaper")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("appearance-nav-item-theme")).not.toHaveAttribute("aria-current")
  })

  it("reports the clicked panel", () => {
    const { onSelect } = renderNav()
    fireEvent.click(screen.getByTestId("appearance-nav-item-a11y"))
    expect(onSelect).toHaveBeenCalledWith("a11y")
  })

  it("omits hidden entries", () => {
    renderNav({ hiddenIds: ["plugins"] })
    expect(screen.queryByTestId("appearance-nav-item-plugins")).not.toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(12)
  })

  // Hiding the only member of a group must not leave a dangling header.
  it("drops a group whose every entry is hidden", () => {
    renderNav({ hiddenIds: ["a11y", "advanced", "plugins"] })
    expect(screen.queryByTestId("appearance-nav-group-advancedGroup")).not.toBeInTheDocument()
    expect(screen.getByTestId("appearance-nav-group-themeGroup")).toBeInTheDocument()
  })

  // Twelve entries would otherwise be twelve tab stops between the section
  // header and the panel the user came here to edit.
  describe("roving focus", () => {
    it("gives the tab stop to the active entry alone", () => {
      renderNav({ activeId: "cursor" })
      expect(screen.getByTestId("appearance-nav-item-cursor")).toHaveAttribute("tabindex", "0")
      for (const id of ["theme", "auto", "advanced"]) {
        expect(screen.getByTestId(`appearance-nav-item-${id}`)).toHaveAttribute("tabindex", "-1")
      }
    })

    it("moves focus to the next entry on ArrowDown", () => {
      renderNav()
      const theme = screen.getByTestId("appearance-nav-item-theme")
      theme.focus()
      fireEvent.keyDown(theme, { key: "ArrowDown" })
      expect(screen.getByTestId("appearance-nav-item-auto")).toHaveFocus()
    })

    // The groups are a visual grouping, not separate widgets.
    it("crosses a group boundary", () => {
      renderNav()
      const library = screen.getByTestId("appearance-nav-item-library")
      library.focus()
      fireEvent.keyDown(library, { key: "ArrowDown" })
      expect(screen.getByTestId("appearance-nav-item-wallpaper")).toHaveFocus()
    })

    it("wraps from the first entry to the last on ArrowUp", () => {
      renderNav()
      // `style` leads the theme group (ADR-0148) and is therefore the first
      // entry the roving order wraps from.
      const first = screen.getByTestId("appearance-nav-item-style")
      first.focus()
      fireEvent.keyDown(first, { key: "ArrowUp" })
      expect(screen.getByTestId("appearance-nav-item-plugins")).toHaveFocus()
    })

    it("skips hidden entries when wrapping", () => {
      renderNav({ hiddenIds: ["plugins"] })
      const first = screen.getByTestId("appearance-nav-item-style")
      first.focus()
      fireEvent.keyDown(first, { key: "ArrowUp" })
      expect(screen.getByTestId("appearance-nav-item-advanced")).toHaveFocus()
    })

    it("jumps to the ends with Home and End", () => {
      renderNav({ activeId: "wallpaper" })
      const wallpaper = screen.getByTestId("appearance-nav-item-wallpaper")
      wallpaper.focus()
      fireEvent.keyDown(wallpaper, { key: "End" })
      expect(screen.getByTestId("appearance-nav-item-plugins")).toHaveFocus()
      fireEvent.keyDown(screen.getByTestId("appearance-nav-item-plugins"), { key: "Home" })
      expect(screen.getByTestId("appearance-nav-item-style")).toHaveFocus()
    })

    // Activation is manual: each selection swaps the whole detail panel and
    // rewrites the URL, which is too much to fire on an arrow key.
    it("does not select the entry focus lands on", () => {
      const { onSelect } = renderNav()
      const theme = screen.getByTestId("appearance-nav-item-theme")
      theme.focus()
      fireEvent.keyDown(theme, { key: "ArrowDown" })
      expect(onSelect).not.toHaveBeenCalled()
    })

    it("hands the tab stop back to the active entry once selection moves", () => {
      const { rerender } = renderNav()
      const theme = screen.getByTestId("appearance-nav-item-theme")
      theme.focus()
      fireEvent.keyDown(theme, { key: "ArrowDown" })
      expect(screen.getByTestId("appearance-nav-item-auto")).toHaveAttribute("tabindex", "0")
      rerender("cursor")
      expect(screen.getByTestId("appearance-nav-item-cursor")).toHaveAttribute("tabindex", "0")
      expect(screen.getByTestId("appearance-nav-item-auto")).toHaveAttribute("tabindex", "-1")
    })

    it("ignores keys it does not own", () => {
      renderNav()
      const theme = screen.getByTestId("appearance-nav-item-theme")
      theme.focus()
      fireEvent.keyDown(theme, { key: "a" })
      expect(theme).toHaveFocus()
    })
  })
})
