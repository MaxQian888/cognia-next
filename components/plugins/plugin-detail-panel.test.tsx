/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(() => Promise.resolve(mockPlugin)),
}))

// The Sheet host children render PluginDetail under their own tree once the
// detail target is non-null. We stub the inner panel so this test stays
// scoped to the host + header behavior.
jest.mock("./plugin-detail", () => ({
  PluginDetail: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="plugin-detail-stub">{pluginId}</div>
  ),
}))

import { PluginDetailPanel } from "./plugin-detail-panel"
import { usePluginsStore } from "@/stores/plugins"

const pluginRow: PluginRow = {
  id: "p_detail",
  name: "Detail Plugin",
  version: "3.4.5",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: [],
  path: "/p/detail",
  manifest: {
    id: "p_detail",
    description: "Detail plugin description",
  },
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(() => {
  mockPlugin = undefined
  usePluginsStore.setState({ detailPluginId: null })
})

describe("PluginDetailPanel", () => {
  it("does not render the panel content when no detail target is selected", () => {
    render(<PluginDetailPanel />)
    expect(screen.queryByTestId("plugin-detail-stub")).not.toBeInTheDocument()
  })

  it("shows the localized loading title while the live query has not resolved", () => {
    usePluginsStore.setState({ detailPluginId: "p_detail" })
    mockPlugin = undefined
    render(<PluginDetailPanel />)
    // The header SheetTitle should pull from t("loadingTitle") — our mock
    // returns the key as-is, so we assert against the key name.
    expect(screen.getByText("loadingTitle")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-detail-stub")).toHaveTextContent("p_detail")
  })

  it("swaps to plugin name + version once the live query resolves", () => {
    usePluginsStore.setState({ detailPluginId: "p_detail" })
    mockPlugin = pluginRow
    render(<PluginDetailPanel />)
    expect(screen.getByText("Detail Plugin")).toBeInTheDocument()
    expect(screen.getByText("v3.4.5")).toBeInTheDocument()
    expect(screen.getByText("Detail plugin description")).toBeInTheDocument()
    expect(screen.queryByText("loadingTitle")).not.toBeInTheDocument()
  })

  it("omits the description block when manifest.description is empty", () => {
    usePluginsStore.setState({ detailPluginId: "p_detail" })
    mockPlugin = {
      ...pluginRow,
      manifest: { id: "p_detail" },
    }
    render(<PluginDetailPanel />)
    expect(screen.getByText("Detail Plugin")).toBeInTheDocument()
    expect(screen.queryByText("Detail plugin description")).not.toBeInTheDocument()
  })
})
