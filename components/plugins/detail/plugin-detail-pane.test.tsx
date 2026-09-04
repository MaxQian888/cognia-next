/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockPlugin: PluginRow | undefined
let mockPhase: "loading" | "resolved" = "resolved"
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T,>(_fn: () => unknown, _deps: unknown[], def?: T) =>
    mockPhase === "loading" ? def : mockPlugin,
}))
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
}))

// Stub heavy sub-tabs — we only verify the pane delegates to the right one
// based on detailSubTab.
jest.mock("./plugin-detail-overview", () => ({
  PluginDetailOverview: () => <div data-testid="overview" />,
}))
jest.mock("./plugin-detail-capabilities", () => ({
  PluginDetailCapabilities: () => <div data-testid="capabilities" />,
}))
jest.mock("./plugin-detail-configure", () => ({
  PluginDetailConfigure: () => <div data-testid="configure" />,
}))
jest.mock("./plugin-detail-permissions", () => ({
  PluginDetailPermissions: () => <div data-testid="permissions" />,
}))
jest.mock("./plugin-detail-data", () => ({
  PluginDetailData: () => <div data-testid="data" />,
}))
jest.mock("./plugin-detail-empty", () => ({
  PluginDetailEmpty: () => <div data-testid="empty" />,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailPane } from "./plugin-detail-pane"

function makePlugin(): PluginRow {
  return {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/alpha",
    manifest: { id: "alpha", description: "Alpha plugin" },
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("PluginDetailPane", () => {
  beforeEach(() => {
    usePluginsStore.setState({ detailPluginId: null, detailSubTab: "overview" })
    mockPlugin = makePlugin()
    mockPhase = "resolved"
  })

  it("renders the empty state when nothing is selected", () => {
    render(<PluginDetailPane />)
    expect(screen.getByTestId("empty")).toBeInTheDocument()
  })

  it.each([
    ["overview", "overview"],
    ["capabilities", "capabilities"],
    ["configure", "configure"],
    ["permissions", "permissions"],
    ["data", "data"],
  ] as const)("delegates to PluginDetail%s when detailSubTab=%s", (subTab, testid) => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: subTab })
    render(<PluginDetailPane />)
    expect(screen.getByTestId(testid)).toBeInTheDocument()
  })

  it("keeps the README/overview body visible even when a section is expanded", () => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "data" })
    render(<PluginDetailPane />)
    // Overview is the always-visible body; the deep-linked section expands too.
    expect(screen.getByTestId("overview")).toBeInTheDocument()
    expect(screen.getByTestId("data")).toBeInTheDocument()
  })

  it("renders collapsible section triggers for capabilities/configure/permissions/data", () => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    for (const v of ["capabilities", "configure", "permissions", "data"]) {
      expect(screen.getByTestId(`plugin-detail-section-${v}`)).toBeInTheDocument()
    }
    // Collapsed sections don't mount their content.
    expect(screen.queryByTestId("capabilities")).not.toBeInTheDocument()
  })

  it.each(["frontend", "python", "hybrid"] as const)(
    "links to the log panel for %s, whose host has an output channel",
    (type) => {
      // It used to be python-only, which hid the frontend half of a hybrid
      // plugin's output and left frontend authors with no log surface here at
      // all.
      mockPlugin = { ...makePlugin(), type }
      usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
      render(<PluginDetailPane />)
      expect(screen.getByTestId("plugin-detail-section-logs")).toBeInTheDocument()
    }
  )

  it("carries the plugin filter into the log panel rather than reading logs itself", () => {
    mockPlugin = { ...makePlugin(), type: "python" }
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    const link = screen.getByTestId("plugin-detail-section-logs")
    const href = link.getAttribute("href") ?? ""
    const url = new URL(href, "http://localhost")
    expect(url.pathname).toBe("/logs")
    expect(url.searchParams.get("src")).toBe("plugin")
    expect(url.searchParams.get("q")).toBe("alpha")
  })

  it.each(["wasm", "vscode-extension"] as const)(
    "hides the log link for %s, whose host serves no output channel",
    (type) => {
      // A link into a panel that can only ever be empty for this runtime reads
      // as a broken reader, so the entry is withheld instead.
      mockPlugin = { ...makePlugin(), type }
      usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
      render(<PluginDetailPane />)
      expect(screen.queryByTestId("plugin-detail-section-logs")).not.toBeInTheDocument()
    }
  )

  it("renders the not-found hint when detailPluginId is set but the row is missing", () => {
    mockPlugin = undefined
    mockPhase = "resolved"
    usePluginsStore.setState({ detailPluginId: "missing" })
    render(<PluginDetailPane />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
  })

  it("renders a skeleton loader while the live-query is still resolving", () => {
    mockPhase = "loading"
    usePluginsStore.setState({ detailPluginId: "alpha" })
    render(<PluginDetailPane />)
    expect(screen.getByTestId("plugin-detail-pane-loading")).toBeInTheDocument()
    // Sub-tab content must not mount while loading.
    expect(screen.queryByTestId("overview")).not.toBeInTheDocument()
  })
})
