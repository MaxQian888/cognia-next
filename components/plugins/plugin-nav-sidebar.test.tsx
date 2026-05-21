/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let devtoolsEnabled = false
jest.mock("@/hooks/plugins", () => ({
  useDevtoolsGate: () => devtoolsEnabled,
}))

import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  devtoolsEnabled = false
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

  it("reveals the library sub-filter chips only when the Library section is active", () => {
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-library-sub-enabled")).toBeInTheDocument()
    usePluginsStore.setState({ activeSection: "discover" })
    render(<PluginNavSidebar />)
    expect(screen.queryAllByTestId("plugin-nav-library-sub-enabled")).toHaveLength(0)
  })

  it("clicking a library sub-filter chip updates the store", () => {
    render(<PluginNavSidebar />)
    fireEvent.click(screen.getByTestId("plugin-nav-library-sub-configurable"))
    expect(usePluginsStore.getState().librarySubFilter).toBe("configurable")
    expect(usePluginsStore.getState().filters.configurable).toBe(true)
  })

  it("reveals the governance sub-views only when the Governance section is active", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginNavSidebar />)
    expect(screen.getByTestId("plugin-nav-governance-sub-audit")).toBeInTheDocument()
  })

  it("clicking a governance sub-view updates the store", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginNavSidebar />)
    fireEvent.click(screen.getByTestId("plugin-nav-governance-sub-audit"))
    expect(usePluginsStore.getState().governanceView).toBe("audit")
  })
})
