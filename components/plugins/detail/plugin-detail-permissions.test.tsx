/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginPermission } from "@/types/plugin"
import type { PluginPermissionTier } from "@/lib/plugin/security/permission-guard"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockPlugin: PluginRow | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

// The approved-binaries card runs its own Dexie live query (which this file's
// blanket `useLiveQuery` stub would answer with a PluginRow) and is covered by
// its co-located test. Stub it to a marker so this suite stays about the
// permission table, while still pinning that the card is mounted here.
jest.mock("./plugin-approved-binaries-card", () => ({
  PluginApprovedBinariesCard: ({ pluginId }: { pluginId: string }) => (
    <div>approved-binaries-card:{pluginId}</div>
  ),
}))
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
}))

// The embedded PluginFrontendTrustCard reads its persisted grant through the
// manager singleton in a state initializer; the real one throws when
// uninitialized.
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    isFrontendTrusted: () => false,
    setFrontendTrust: jest.fn(),
  }),
}))

const mockGetGranted = jest.fn<PluginPermission[], [string]>(() => [])
const mockSetTier = jest.fn()

jest.mock("@/hooks/plugins", () => ({
  usePluginPermissions: () => ({
    groups: {},
    dangerous: [],
    descriptions: {},
    getGranted: mockGetGranted,
    getHolders: jest.fn(() => []),
    auditLog: [],
    grant: jest.fn(),
    revoke: jest.fn(),
    revokeAll: jest.fn(),
    request: jest.fn(),
    isDangerous: (perm: string) => perm === "shell:execute",
    getTier: () => "silent" as PluginPermissionTier,
    setTier: mockSetTier,
    getTiersForPlugin: () => [],
  }),
  usePluginRow: () =>
    mockPlugin === undefined
      ? { state: "not-found" as const }
      : { state: "ready" as const, row: mockPlugin },
  usePluginDiagnostics: () => [],
}))

// PermissionRow is what we're verifying we reuse.
import { PluginDetailPermissions } from "./plugin-detail-permissions"

function makePlugin(perms: PluginPermission[]): PluginRow {
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
    manifest: { id: "alpha", permissions: perms },
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("PluginDetailPermissions", () => {
  beforeEach(() => {
    mockGetGranted.mockReturnValue([])
  })

  it("renders the no-permissions empty state when nothing declared, optional, or granted", () => {
    mockPlugin = makePlugin([])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getByText("noPermissions")).toBeInTheDocument()
  })

  it("renders one PermissionRow per declared permission", () => {
    mockPlugin = makePlugin(["clipboard:read", "shell:execute"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    // Each row renders the permission code AND a description fallback that
    // mirrors the same string when no description map is registered — hence
    // `getAllByText` returns 2 nodes per permission.
    expect(screen.getAllByText("clipboard:read").length).toBeGreaterThan(0)
    expect(screen.getAllByText("shell:execute").length).toBeGreaterThan(0)
  })

  it("mounts the approved-binaries card so durable grants are revocable", () => {
    // A permanent binary grant the user cannot see or withdraw is its own
    // security problem; the ledger's only reader has to be reachable.
    mockPlugin = makePlugin(["cli:execute"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getByText("approved-binaries-card:alpha")).toBeInTheDocument()
  })

  it("merges declared + granted permissions into one sorted list", () => {
    mockPlugin = makePlugin(["clipboard:read"])
    mockGetGranted.mockReturnValue(["network:fetch"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getAllByText("clipboard:read").length).toBeGreaterThan(0)
    expect(screen.getAllByText("network:fetch").length).toBeGreaterThan(0)
  })

  it("renders the frontend trust card for a renderer-JS plugin from an untrusted source", () => {
    // makePlugin defaults to type:"frontend" + source:"marketplace" — the
    // exact combination the trust boundary gates.
    mockPlugin = makePlugin(["clipboard:read"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getByTestId("plugin-frontend-trust-card")).toBeInTheDocument()
  })

  it("renders the frontend trust card in the no-permissions empty state too", () => {
    mockPlugin = makePlugin([])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getByText("noPermissions")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-frontend-trust-card")).toBeInTheDocument()
  })

  it("does not render the trust card for an inherently trusted source", () => {
    mockPlugin = { ...makePlugin(["clipboard:read"]), source: "builtin" }
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.queryByTestId("plugin-frontend-trust-card")).not.toBeInTheDocument()
  })

  it("does not render the trust card for an isolated-host plugin type", () => {
    mockPlugin = { ...makePlugin(["clipboard:read"]), type: "wasm" }
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.queryByTestId("plugin-frontend-trust-card")).not.toBeInTheDocument()
  })
})
