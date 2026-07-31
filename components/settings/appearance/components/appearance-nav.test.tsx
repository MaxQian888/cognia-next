/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { AppearanceNav } from "./appearance-nav"
import { APPEARANCE_NAV_GROUPS } from "../nav-config"

function renderNav(overrides: Partial<React.ComponentProps<typeof AppearanceNav>> = {}) {
  const onSelect = jest.fn()
  render(
    <AppearanceNav
      groups={APPEARANCE_NAV_GROUPS}
      activeId="theme"
      onSelect={onSelect}
      {...overrides}
    />
  )
  return { onSelect }
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
    expect(screen.getAllByRole("listitem")).toHaveLength(11)
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
    expect(screen.getAllByRole("listitem")).toHaveLength(10)
  })

  // Hiding the only member of a group must not leave a dangling header.
  it("drops a group whose every entry is hidden", () => {
    renderNav({ hiddenIds: ["a11y", "advanced", "plugins"] })
    expect(screen.queryByTestId("appearance-nav-group-advancedGroup")).not.toBeInTheDocument()
    expect(screen.getByTestId("appearance-nav-group-themeGroup")).toBeInTheDocument()
  })
})
