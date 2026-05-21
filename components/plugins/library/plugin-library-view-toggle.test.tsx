/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginLibraryViewToggle } from "./plugin-library-view-toggle"

beforeEach(() => {
  usePluginsStore.setState({ listViewMode: "list" })
})

describe("PluginLibraryViewToggle", () => {
  it("reflects the current listViewMode from the store", () => {
    usePluginsStore.setState({ listViewMode: "card" })
    render(<PluginLibraryViewToggle />)
    expect(screen.getByTestId("plugin-library-view-card").getAttribute("data-state")).toBe("on")
    expect(screen.getByTestId("plugin-library-view-list").getAttribute("data-state")).toBe("off")
  })

  it("clicking the card option flips the store", () => {
    render(<PluginLibraryViewToggle />)
    fireEvent.click(screen.getByTestId("plugin-library-view-card"))
    expect(usePluginsStore.getState().listViewMode).toBe("card")
  })

  it("clicking list flips the store back", () => {
    usePluginsStore.setState({ listViewMode: "card" })
    render(<PluginLibraryViewToggle />)
    fireEvent.click(screen.getByTestId("plugin-library-view-list"))
    expect(usePluginsStore.getState().listViewMode).toBe("list")
  })
})
