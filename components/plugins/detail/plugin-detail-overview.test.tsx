/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

let mockPlugin: PluginRow | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailOverview } from "./plugin-detail-overview"

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "alpha",
    name: "Alpha",
    version: "1.2.3",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/alpha",
    manifest: {
      id: "alpha",
      description: "Alpha plugin",
      author: "Team",
      license: "MIT",
      homepage: "https://example.com",
    },
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 1, 1),
    ...overrides,
  }
}

describe("PluginDetailOverview", () => {
  beforeEach(() => {
    mockPlugin = makePlugin()
    usePluginsStore.setState({ rollbackTarget: null })
  })

  it("renders core meta rows from the manifest", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("1.2.3")).toBeInTheDocument()
    expect(screen.getByText("MIT")).toBeInTheDocument()
    expect(screen.getByText("https://example.com")).toBeInTheDocument()
  })

  it("shows the error card when plugin.error is set", () => {
    mockPlugin = makePlugin({ error: "boom", status: "error" })
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.getByText("metaError")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("opens the rollback target when the Rollback button is clicked", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    fireEvent.click(screen.getByLabelText("rollbackAria:Alpha"))
    expect(usePluginsStore.getState().rollbackTarget).toBe("alpha")
  })

  it("renders the View raw manifest dialog when clicked", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    fireEvent.click(screen.getByText("rawManifest"))
    expect(screen.getByText("rawManifestTitle")).toBeInTheDocument()
  })
})
