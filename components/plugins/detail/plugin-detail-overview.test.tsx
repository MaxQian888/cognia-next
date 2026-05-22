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

// In-memory PluginManager store — drives the new Verification card. Default
// to no snapshot so existing tests still see the original Overview shape.
let mockPluginInMemory:
  | {
      verificationSnapshot?: unknown
      lastKnownGoodVerification?: unknown
    }
  | undefined
jest.mock("@/stores/plugin/plugin-store", () => ({
  usePluginStore: (selector: (s: unknown) => unknown) =>
    selector({ plugins: mockPluginInMemory ? { alpha: mockPluginInMemory } : {} }),
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
    mockPluginInMemory = undefined
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

  it("hides the Verification card when no snapshot exists in memory", () => {
    render(<PluginDetailOverview pluginId="alpha" />)
    expect(screen.queryByTestId("plugin-detail-verification-card")).not.toBeInTheDocument()
  })

  it("renders the Verification card when a snapshot is available", () => {
    mockPluginInMemory = {
      verificationSnapshot: {
        pluginId: "alpha",
        source: "marketplace",
        status: "enabled",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-22T00:00:00Z",
        lastSuccessfulAt: "2026-05-22T00:00:00Z",
        resolvedVersion: "1.2.3",
        diagnostics: [],
      },
    }
    render(<PluginDetailOverview pluginId="alpha" />)
    const card = screen.getByTestId("plugin-detail-verification-card")
    expect(card).toBeInTheDocument()
    expect(card.textContent).toContain("title")
    // Snapshot status pill within the card.
    expect(card.textContent).toContain("enabled")
    // verificationStage badge within the card.
    expect(card.textContent).toContain("activation")
  })

  it("surfaces a rollback CTA when current and last-good diverge", () => {
    mockPluginInMemory = {
      verificationSnapshot: {
        pluginId: "alpha",
        source: "marketplace",
        status: "error",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-22T00:00:00Z",
        lastFailureAt: "2026-05-22T00:00:00Z",
        resolvedVersion: "1.3.0",
        diagnostics: [],
      },
      lastKnownGoodVerification: {
        pluginId: "alpha",
        source: "marketplace",
        status: "enabled",
        verificationStage: "activation",
        lastVerifiedAction: "enable",
        lastVerifiedAt: "2026-05-01T00:00:00Z",
        lastSuccessfulAt: "2026-05-01T00:00:00Z",
        resolvedVersion: "1.2.3",
        diagnostics: [],
      },
    }
    render(<PluginDetailOverview pluginId="alpha" />)
    const card = screen.getByTestId("plugin-detail-verification-card")
    expect(card).toBeInTheDocument()
    // Rollback CTA renders within the Verification card.
    expect(card.textContent).toContain("rollbackTo")
    expect(card.textContent).toContain("1.2.3")
  })
})
