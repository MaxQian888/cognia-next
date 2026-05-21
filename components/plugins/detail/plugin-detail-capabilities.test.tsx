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

// PluginContributedTab and PluginTriggersTab pull from heavy registries —
// stub them so this test stays narrow.
jest.mock("../plugin-contributed-tab", () => ({
  PluginContributedTab: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="contributed" data-plugin-id={pluginId} />
  ),
}))
jest.mock("../plugin-triggers-tab", () => ({
  PluginTriggersTab: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="triggers" data-plugin-id={pluginId} />
  ),
}))

import { PluginDetailCapabilities } from "./plugin-detail-capabilities"

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: ["tools", "commands"],
    path: "/plugins/alpha",
    manifest: { id: "alpha" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("PluginDetailCapabilities", () => {
  it("renders capability badges from the plugin row", () => {
    mockPlugin = makePlugin()
    render(<PluginDetailCapabilities pluginId="alpha" />)
    expect(screen.getByText("tools")).toBeInTheDocument()
    expect(screen.getByText("commands")).toBeInTheDocument()
  })

  it("renders contributes + activation events when present in the manifest", () => {
    mockPlugin = makePlugin({
      capabilities: [],
      manifest: {
        id: "alpha",
        contributes: { tools: 1 },
        activationEvents: ["onStartup"],
      },
    })
    render(<PluginDetailCapabilities pluginId="alpha" />)
    expect(screen.getByText("tools")).toBeInTheDocument()
    expect(screen.getByText("onStartup")).toBeInTheDocument()
  })

  it("renders the noCapabilities message when nothing to show", () => {
    mockPlugin = makePlugin({ capabilities: [], manifest: { id: "alpha" } })
    render(<PluginDetailCapabilities pluginId="alpha" />)
    expect(screen.getByText("noCapabilities")).toBeInTheDocument()
  })

  it("composes the existing PluginContributedTab + PluginTriggersTab", () => {
    mockPlugin = makePlugin()
    render(<PluginDetailCapabilities pluginId="alpha" />)
    expect(screen.getByTestId("contributed").getAttribute("data-plugin-id")).toBe("alpha")
    expect(screen.getByTestId("triggers").getAttribute("data-plugin-id")).toBe("alpha")
  })
})
