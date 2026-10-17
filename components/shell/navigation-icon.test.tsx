/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"
import { CompassIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"
import { NavigationIcon } from "./navigation-icon"

beforeEach(() => {
  useSettingsStore.setState({ settings: null })
})

it.each([...SIDEBAR_NAV_META.map((item) => item.id), "chat", "canvas", "settings"])(
  "defaults %s to decorative anime artwork",
  (id) => {
    const { container } = render(<NavigationIcon id={id} fallback={CompassIcon} />)
    expect(container.querySelector("[data-navigation-artwork]")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
    expect(container.querySelector("img")).toHaveAttribute("width", "28")
    expect(container.querySelector("img")).toHaveClass("size-7", "shrink-0")
  }
)

it("updates live in both directions using the existing preference", () => {
  const { container } = render(
    <NavigationIcon id="discover" fallback={CompassIcon} className="size-4 text-muted-foreground" />
  )
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "ordinary" } as never }))
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("svg")).toHaveClass("lucide-compass", "size-4")
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "anime" } as never }))
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "/icons/cognia-mobile-spots/png/discover.png"
  )
})

it("preserves unregistered icons", () => {
  const { container } = render(<NavigationIcon id="third-party:tool" fallback={CompassIcon} />)
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("svg")).toHaveClass("lucide-compass")
})
