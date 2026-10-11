/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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

import { PluginDetailData, RESOURCE_LIMITS } from "./plugin-detail-data"
import { DEFAULT_RATE_LIMITS } from "@/lib/plugin/security/rate-limiter"

function makeRow(manifest: Record<string, unknown>): PluginRow {
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
    manifest: { id: "alpha", ...manifest },
    createdAt: 0,
    updatedAt: 0,
  } as PluginRow
}

const SECTIONS = [
  "data-sub-tables",
  "data-sub-schedules",
  "data-sub-analytics",
  "data-sub-backup",
  "data-sub-resources",
  "data-sub-dependencies",
]

describe("PluginDetailData", () => {
  it("composes six per-plugin surfaces, all visible, and threads pluginId through each", () => {
    mockPlugin = makeRow({ dependencies: { foo: "1.0.0" } })
    render(<PluginDetailData pluginId="alpha" />)
    // No collapsibles to open: every surface mounts immediately.
    for (const testid of [
      "data-mgmt",
      "scheduled-jobs",
      "analytics",
      "backup-panel",
      "resource-manager",
      "dep-graph",
    ]) {
      const child = screen.getByTestId(testid)
      expect(child).toBeVisible()
      expect(child.getAttribute("data-plugin-id")).toBe("alpha")
    }
  })

  it("draws flat sections with a heading and hairline, never a bordered box", () => {
    mockPlugin = makeRow({})
    render(<PluginDetailData pluginId="alpha" />)
    for (const id of SECTIONS) {
      const section = screen.getByTestId(id)
      expect(section.tagName).toBe("SECTION")
      expect(section).toHaveAttribute("data-slot", "plugin-detail-group")
      expect(section).toHaveClass("border-t")
      expect(section).not.toHaveClass("rounded-md")
      expect(section).not.toHaveAttribute("data-state")
    }
    expect(screen.getByRole("heading", { name: "sectionTables" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "sectionDependencies" })).toBeInTheDocument()
    expect(screen.getByTestId("plugin-detail-data")).toHaveClass("@container")
  })

  it("shows the declared dependency count in the section heading without expanding", () => {
    mockPlugin = makeRow({ dependencies: { foo: "1.0.0", bar: "^2" } })
    render(<PluginDetailData pluginId="alpha" />)
    expect(screen.getByTestId("data-sub-dependencies-summary")).toHaveTextContent(
      'dependencyCount:{"count":2}'
    )
  })

  it("counts zero declared dependencies when the manifest has none", () => {
    mockPlugin = makeRow({})
    render(<PluginDetailData pluginId="alpha" />)
    expect(screen.getByTestId("data-sub-dependencies-summary")).toHaveTextContent(
      'dependencyCount:{"count":0}'
    )
  })

  it("renders the notFound message when the plugin row is missing", () => {
    mockPlugin = undefined
    render(<PluginDetailData pluginId="missing" />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
  })
})

describe("RESOURCE_LIMITS", () => {
  it("reports the sustained per-minute rate and the burst for every bucket", () => {
    const fetch = RESOURCE_LIMITS.find((rule) => rule.key === "network:fetch")
    expect(fetch).toEqual({ key: "network:fetch", limit: 60, windowMs: 60_000, burst: 60 })
    // 0.2 tokens/s is 12 a minute, not "20 per 5 s".
    const shell = RESOURCE_LIMITS.find((rule) => rule.key === "shell:execute")
    expect(shell).toEqual({ key: "shell:execute", limit: 12, windowMs: 60_000, burst: 10 })
    expect(RESOURCE_LIMITS).toHaveLength(Object.keys(DEFAULT_RATE_LIMITS).length)
    for (const rule of RESOURCE_LIMITS) expect(Number.isInteger(rule.limit)).toBe(true)
  })
})
