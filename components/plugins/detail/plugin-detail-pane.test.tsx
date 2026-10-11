/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
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

// Stub heavy tabs — we only verify the pane shows the right one for
// detailSubTab.
jest.mock("./plugin-detail-overview", () => ({
  PluginDetailOverview: ({ onFilterApplied }: { onFilterApplied?: () => void }) => (
    <div data-testid="overview">
      <button type="button" data-testid="overview-filter" onClick={() => onFilterApplied?.()} />
    </div>
  ),
}))
// The header has its own suite; here only the props it is handed matter.
jest.mock("./plugin-detail-header", () => ({
  PluginDetailHeader: ({ onClose }: { onClose?: () => void }) => (
    <header>
      <button type="button" data-testid="header-close" onClick={() => onClose?.()} />
    </header>
  ),
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

  it("shows exactly one tab body at a time", () => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "data" })
    render(<PluginDetailPane />)
    expect(screen.getByTestId("data")).toBeInTheDocument()
    expect(screen.queryByTestId("overview")).not.toBeInTheDocument()
    expect(screen.queryByTestId("capabilities")).not.toBeInTheDocument()
  })

  it("renders a tab for every section and switches through the store", async () => {
    const user = userEvent.setup()
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.getAttribute("data-testid"))).toEqual([
      "plugin-detail-tab-overview",
      "plugin-detail-tab-capabilities",
      "plugin-detail-tab-configure",
      "plugin-detail-tab-permissions",
      "plugin-detail-tab-data",
    ])
    await user.click(screen.getByTestId("plugin-detail-tab-permissions"))
    expect(usePluginsStore.getState().detailSubTab).toBe("permissions")
    expect(screen.getByTestId("permissions")).toBeInTheDocument()
  })

  it("counts declared permissions and runtime capabilities on their tabs", () => {
    mockPlugin = {
      ...makePlugin(),
      capabilities: ["tools", "themes"],
      manifest: {
        id: "alpha",
        permissions: ["network:fetch", "clipboard:read"],
        optionalPermissions: ["fs:read"],
      } as never,
    }
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    expect(screen.getByTestId("plugin-detail-tab-permissions")).toHaveTextContent("3")
    expect(screen.getByTestId("plugin-detail-tab-permissions")).toHaveAttribute(
      "aria-label",
      "tabCountAria"
    )
    expect(screen.getByTestId("plugin-detail-tab-capabilities").textContent).toMatch(/\d/)
    // Overview carries no count.
    expect(screen.getByTestId("plugin-detail-tab-overview").textContent).toBe("subtab.overview")
  })

  it("mutes the Configure tab when the plugin has nothing to configure", () => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    expect(screen.getByTestId("plugin-detail-tab-configure").className).toContain(
      "text-muted-foreground/70"
    )
  })

  it("makes the active tab body the pane's only scroller", () => {
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane />)
    expect(screen.getByTestId("plugin-detail-tab-panel-overview")).toHaveClass(
      "overflow-y-auto",
      "min-h-0",
      "flex-1"
    )
  })

  it("hands the close callback to the header and the filter callback to the overview", () => {
    const onClose = jest.fn()
    const onFilterApplied = jest.fn()
    usePluginsStore.setState({ detailPluginId: "alpha", detailSubTab: "overview" })
    render(<PluginDetailPane onClose={onClose} onFilterApplied={onFilterApplied} />)
    screen.getByTestId("header-close").click()
    expect(onClose).toHaveBeenCalled()
    screen.getByTestId("overview-filter").click()
    expect(onFilterApplied).toHaveBeenCalled()
  })

  it("gives a missing plugin a way out instead of a dead end", () => {
    mockPlugin = undefined
    mockPhase = "resolved"
    usePluginsStore.setState({ detailPluginId: "missing" })
    render(<PluginDetailPane />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
    expect(screen.getByText("notFoundHint")).toBeInTheDocument()
    screen.getByRole("button", { name: "notFoundAction" }).click()
    expect(usePluginsStore.getState().detailPluginId).toBeNull()
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
