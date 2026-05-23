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

// Each child is a heavyweight component that pulls its own Dexie + registry
// data — stub them so we only verify the composition shape.
jest.mock("@/components/settings/plugins/plugin-data-management", () => ({
  PluginDataManagement: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="data-mgmt" data-plugin-id={pluginId} />
  ),
}))
jest.mock("./plugin-scheduled-jobs", () => ({
  PluginScheduledJobs: ({ pluginId }: { pluginId?: string }) => (
    <div data-testid="scheduled-jobs" data-plugin-id={pluginId} />
  ),
}))
jest.mock("./plugin-analytics", () => ({
  PluginAnalytics: ({ pluginId }: { pluginId?: string }) => (
    <div data-testid="analytics" data-plugin-id={pluginId} />
  ),
}))
jest.mock("../plugin-backup-panel", () => ({
  PluginBackupPanel: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="backup-panel" data-plugin-id={pluginId} />
  ),
}))
jest.mock("./plugin-resource-manager", () => ({
  PluginResourceManager: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="resource-manager" data-plugin-id={pluginId} />
  ),
}))
jest.mock("./plugin-dependency-graph", () => ({
  PluginDependencyGraph: ({ manifest }: { manifest: { id: string } }) => (
    <div data-testid="dep-graph" data-plugin-id={manifest.id} />
  ),
}))

import { PluginDetailData } from "./plugin-detail-data"

describe("PluginDetailData", () => {
  it("composes six per-plugin surfaces and threads pluginId through each", () => {
    mockPlugin = {
      id: "alpha",
      name: "Alpha",
      version: "1.0.0",
      status: "enabled",
      source: "marketplace",
      type: "frontend",
      enabled: true,
      capabilities: [],
      path: "/plugins/alpha",
      manifest: { id: "alpha", dependencies: { foo: "1.0.0" } },
      createdAt: 0,
      updatedAt: 0,
    }
    render(<PluginDetailData pluginId="alpha" />)
    for (const testid of [
      "data-mgmt",
      "scheduled-jobs",
      "analytics",
      "backup-panel",
      "resource-manager",
      "dep-graph",
    ]) {
      expect(screen.getByTestId(testid).getAttribute("data-plugin-id")).toBe("alpha")
    }
  })

  it("renders the notFound message when the plugin row is missing", () => {
    mockPlugin = undefined
    render(<PluginDetailData pluginId="missing" />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
  })
})
