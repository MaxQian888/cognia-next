/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { usePluginsStore } from "@/stores/plugins"

import { PluginDiscoverHeader } from "./plugin-discover-header"

beforeEach(() => {
  usePluginsStore.setState({
    discoverCuration: "all",
    discoverOrigin: "all",
    filters: { ...usePluginsStore.getState().filters, query: "" },
  })
})

describe("PluginDiscoverHeader", () => {
  // The pane used to draw its own Card toolbar with an eight-item switch,
  // which is the migration `plugin-section-toolbar.tsx` was written for and
  // never received. Discover now feeds the same tier every other section does.
  it("renders inside the shared section toolbar", () => {
    render(<PluginDiscoverHeader />)
    expect(screen.getByTestId("plugin-discover-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-discover-search")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-discover-origin")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-discover-curation")).toBeInTheDocument()
  })

  it("writes the search into the shared filters", async () => {
    render(<PluginDiscoverHeader />)
    await userEvent.type(screen.getByTestId("plugin-discover-search"), "web")
    expect(usePluginsStore.getState().filters.query).toBe("web")
  })

  it("forwards the stacked layout to the toolbar", () => {
    render(<PluginDiscoverHeader layout="stacked" />)
    expect(screen.getByTestId("plugin-discover-toolbar")).toHaveAttribute("data-layout", "stacked")
  })

  /**
   * Featured / popular / recent are rankings the cognia registry publishes.
   * A git catalog or Open VSX has none, so the control says so rather than
   * offering a ranking that would silently do nothing.
   */
  it("disables the ranking for an origin that cannot answer one", () => {
    usePluginsStore.setState({ discoverOrigin: "vscode" })
    render(<PluginDiscoverHeader />)
    expect(screen.getByTestId("plugin-discover-curation")).toBeDisabled()
    expect(screen.getByTestId("plugin-discover-curation-blocked")).toBeInTheDocument()
  })

  it("leaves the ranking live for registry-backed origins", () => {
    usePluginsStore.setState({ discoverOrigin: "registry" })
    render(<PluginDiscoverHeader />)
    expect(screen.getByTestId("plugin-discover-curation")).not.toBeDisabled()
    expect(screen.queryByTestId("plugin-discover-curation-blocked")).toBeNull()
  })
})
