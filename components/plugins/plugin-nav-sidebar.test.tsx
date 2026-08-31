/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { renderToString } from "react-dom/server"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let devtoolsEnabled = false
let pluginTotals = { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 }
jest.mock("@/hooks/plugins", () => ({
  useDevtoolsGate: () => devtoolsEnabled,
  usePlugins: () => ({ totals: pluginTotals }),
}))

let inDesktopShell = false
jest.mock("@/lib/tauri", () => ({ isTauri: () => inDesktopShell }))

import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  devtoolsEnabled = false
  inDesktopShell = false
  pluginTotals = { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 }
  usePluginsStore.setState({
    activeSection: "library",
    librarySubFilter: "all",
    governanceView: "permissions",
  })
})

describe("PluginNavSidebar", () => {
  it("renders the three always-visible sections", () => {
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-library")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-nav-discover")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-nav-governance")).toBeInTheDocument()
  })

  it("hides the devtools section when the gate is closed", () => {
    devtoolsEnabled = false
    render(<PluginNavSidebar />)
    expect(screen.queryByTestId("plugin-nav-devtools")).not.toBeInTheDocument()
  })

  it("renders the devtools section when the gate is open", () => {
    devtoolsEnabled = true
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-devtools")).toBeInTheDocument()
  })

  /**
   * Pi's package manager needs a config file and a CLI, so it cannot run on
   * the web or on mobile. It used to be dropped from the rail entirely, which
   * collapsed "does not exist", "needs the desktop app" and "is broken" into
   * one blank space. It is now rendered, disabled, and says which.
   */
  it("disables agent packages outside the desktop shell and says why", () => {
    inDesktopShell = false
    render(<PluginNavSidebar />)
    const entry = screen.getByTestId("plugin-nav-agent-packages")
    expect(entry).toBeDisabled()
    expect(entry).toHaveAttribute("data-disabled-reason", "desktop")
    expect(entry).toHaveAttribute("title", "desktopOnlyHint")
  })

  it("renders agent packages in the desktop shell", () => {
    inDesktopShell = true
    render(<PluginNavSidebar />)
    const entry = screen.getByTestId("plugin-nav-agent-packages")
    expect(entry).toBeInTheDocument()
    expect(entry).not.toBeDisabled()
  })

  // "3 updates waiting" and "1 plugin failed" used to require entering the
  // Library section to discover.
  it("badges Library with the update and error counts", () => {
    pluginTotals = { total: 5, enabled: 4, errored: 1, loading: 0, updateAvailable: 3 }
    render(<PluginNavSidebar />)
    const library = screen.getByTestId("plugin-nav-library")
    expect(library).toHaveTextContent("3")
    expect(library).toHaveTextContent("1")
  })

  it("drops the badges when both counts are zero", () => {
    render(<PluginNavSidebar />)
    const library = screen.getByTestId("plugin-nav-library")
    expect(library.textContent).toBe("library")
  })

  /**
   * The shell must be read through `useSyncExternalStore`'s server snapshot,
   * not during render. This app is a static export: the server render happens
   * at build time, where `isTauri()` is always false. So the desktop entry is
   * emitted DISABLED into the server HTML and enables itself on the client.
   *
   * Asserting on the server render is the only way to pin that: after mount
   * the snapshot has already resolved, so a client-side query cannot tell the
   * two implementations apart.
   */
  it("emits the desktop entry as disabled in the server render even inside Tauri", () => {
    inDesktopShell = true
    const html = renderToString(<PluginNavSidebar />)
    expect(html).toContain("plugin-nav-agent-packages")
    expect(html).toContain('data-disabled-reason="desktop"')
    expect(html).toContain("plugin-nav-library")
  })

  it("marks the active section via aria-current=page", () => {
    usePluginsStore.setState({ activeSection: "discover" })
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-discover").getAttribute("aria-current")).toBe("page")
    expect(screen.getByTestId("plugin-nav-library").getAttribute("aria-current")).toBeNull()
  })

  it("clicking a section updates the store", () => {
    render(<PluginNavSidebar />)
    fireEvent.click(screen.getByTestId("plugin-nav-discover"))
    expect(usePluginsStore.getState().activeSection).toBe("discover")
  })

  // The rail carries one axis: which section you are in. Library's status
  // filter moved to PluginLibraryHeader and Governance's aggregate-view
  // picker to PluginGovernanceHeader — both as segments in the shared
  // second header tier. Rendering either here too would put two axes back
  // in one column, so these two tests pin the rail's emptiness rather than
  // its old sub-lists.
  it("never renders the library sub-filters, even on the Library section", () => {
    usePluginsStore.setState({ activeSection: "library" })
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-library")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-nav-library-sub-enabled")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plugin-nav-library-sub-configurable")).not.toBeInTheDocument()
  })

  it("leaves librarySubFilter untouched when the Library section is selected", () => {
    usePluginsStore.setState({ activeSection: "discover", librarySubFilter: "errored" })
    render(<PluginNavSidebar />)
    fireEvent.click(screen.getByTestId("plugin-nav-library"))
    expect(usePluginsStore.getState().activeSection).toBe("library")
    expect(usePluginsStore.getState().librarySubFilter).toBe("errored")
  })

  it("never renders the governance sub-views, even on the Governance section", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-governance")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-nav-governance-sub-audit")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plugin-nav-governance-sub-permissions")).not.toBeInTheDocument()
  })

  it("leaves governanceView untouched when the Governance section is selected", () => {
    usePluginsStore.setState({ activeSection: "library", governanceView: "audit" })
    render(<PluginNavSidebar />)
    fireEvent.click(screen.getByTestId("plugin-nav-governance"))
    expect(usePluginsStore.getState().activeSection).toBe("governance")
    expect(usePluginsStore.getState().governanceView).toBe("audit")
  })
})
