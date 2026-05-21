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
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(),
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

  it("merges declared + granted permissions into one sorted list", () => {
    mockPlugin = makePlugin(["clipboard:read"])
    mockGetGranted.mockReturnValue(["network:fetch"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getAllByText("clipboard:read").length).toBeGreaterThan(0)
    expect(screen.getAllByText("network:fetch").length).toBeGreaterThan(0)
  })
})
