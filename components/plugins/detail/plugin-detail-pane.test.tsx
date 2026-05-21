/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockPlugin: PluginRow | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
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

  it("renders the not-found hint when detailPluginId is set but the row is missing", () => {
    mockPlugin = undefined
    usePluginsStore.setState({ detailPluginId: "missing" })
    render(<PluginDetailPane />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
  })
})
