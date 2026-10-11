/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginPermission } from "@/types/plugin"
import type {
  PermissionAuditEntry,
  PluginPermissionTier,
} from "@/lib/plugin/security/permission-guard"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  // Audit rows format their time through next-intl.
  useFormatter: () => ({ dateTime: (v: Date | number) => new Date(v).toISOString() }),
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
let mockAuditLog: PermissionAuditEntry[] = []

jest.mock("@/hooks/plugins", () => ({
  usePluginPermissions: () => ({
    groups: {},
    dangerous: [],
    descriptions: {},
    getGranted: mockGetGranted,
    getHolders: jest.fn(() => []),
    auditLog: mockAuditLog,
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
  usePermissionDescription: () => (perm: string) => `described:${perm}`,
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
    mockAuditLog = []
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

  it("describes each permission with the localized description", () => {
    mockPlugin = makePlugin(["clipboard:read"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    expect(screen.getByText("described:clipboard:read")).toBeInTheDocument()
  })

  it("marks unsupported Node network and subprocess grants unavailable", () => {
    mockPlugin = {
      ...makePlugin(["filesystem:read", "network:fetch", "process:spawn"]),
      manifest: {
        id: "alpha",
        permissions: ["filesystem:read", "network:fetch", "process:spawn"],
        runtimeCompatibility: { tauri: { availability: "supported", entrypoint: "node" } },
      },
    }
    render(<PluginDetailPermissions pluginId="alpha" />)

    expect(screen.getByText("nodeNetworkUnavailable")).toBeInTheDocument()
    expect(screen.getByText("nodeSubprocessUnavailable")).toBeInTheDocument()
    expect(
      screen
        .getAllByRole<HTMLButtonElement>("button", { name: "grant" })
        .filter((button) => button.disabled)
    ).toHaveLength(2)
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

  // The tab owns the pane's full height and the pane is the scroller: no
  // outer border box, no nested scroll region.
  it("renders the permission list flat, under a small heading with a count", () => {
    mockPlugin = makePlugin(["clipboard:read", "shell:execute"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    const group = screen.getByTestId("plugin-permissions-list")
    expect(within(group).getByRole("heading", { name: "listTitle" })).toBeInTheDocument()
    expect(within(group).getByText("2")).toBeInTheDocument()
    const list = within(group).getByRole("list", { name: "listTitle" })
    let node: HTMLElement | null = list
    while (node && node !== group) {
      expect(node.className).not.toMatch(/(^|\s)(rounded(-\w+)?|border)(\s|$)/)
      node = node.parentElement
    }
    // Rows are flush with the heading; only the dialog insets them.
    const row = screen.getByText("clipboard:read").closest("li") as HTMLElement
    expect(row.className).not.toContain("px-3")
  })

  it("shows the empty audit state as plain text", () => {
    mockPlugin = makePlugin(["clipboard:read"])
    render(<PluginDetailPermissions pluginId="alpha" />)
    const audit = screen.getByTestId("plugin-permissions-audit")
    expect(within(audit).getByText("auditEmpty")).toBeInTheDocument()
    expect(within(audit).queryByRole("button")).not.toBeInTheDocument()
  })

  it("shows the newest 10 audit events and expands in place to the rest", async () => {
    const user = userEvent.setup()
    mockPlugin = makePlugin(["clipboard:read"])
    // 30 events for this plugin (the tab keeps the last 25) plus one for
    // another plugin that must never appear.
    mockAuditLog = [
      ...Array.from({ length: 30 }, (_, i) => ({
        pluginId: "alpha",
        permission: "clipboard:read" as PluginPermission,
        action: "check" as const,
        allowed: true,
        timestamp: Date.UTC(2026, 0, 1, 0, 0, i),
      })),
      {
        pluginId: "beta",
        permission: "shell:execute" as PluginPermission,
        action: "deny" as const,
        allowed: false,
        timestamp: Date.UTC(2026, 0, 1, 0, 1, 0),
      },
    ]
    render(<PluginDetailPermissions pluginId="alpha" />)
    const audit = screen.getByTestId("plugin-permissions-audit")
    const list = () => within(audit).getAllByRole("list")[0]
    expect(within(list()).getAllByRole("listitem")).toHaveLength(10)
    // Newest first: second 29 leads.
    expect(within(list()).getAllByRole("listitem")[0]).toHaveTextContent(
      new Date(Date.UTC(2026, 0, 1, 0, 0, 29)).toISOString()
    )
    expect(audit.querySelector("[data-radix-scroll-area-viewport]")).toBeNull()

    const toggle = within(audit).getByRole("button", { name: 'auditShowAll:{"count":25}' })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveAttribute("aria-controls", list().id)
    await user.click(toggle)
    expect(within(list()).getAllByRole("listitem")).toHaveLength(25)
    expect(within(audit).queryByText("shell:execute")).not.toBeInTheDocument()

    const collapse = within(audit).getByRole("button", { name: "auditShowFewer" })
    expect(collapse).toHaveAttribute("aria-expanded", "true")
    await user.click(collapse)
    expect(within(list()).getAllByRole("listitem")).toHaveLength(10)
  })

  it("offers no toggle when every audit event already fits", () => {
    mockPlugin = makePlugin(["clipboard:read"])
    mockAuditLog = Array.from({ length: 10 }, (_, i) => ({
      pluginId: "alpha",
      permission: "clipboard:read" as PluginPermission,
      action: "grant" as const,
      allowed: true,
      timestamp: i + 1,
    }))
    render(<PluginDetailPermissions pluginId="alpha" />)
    const audit = screen.getByTestId("plugin-permissions-audit")
    expect(within(audit).getAllByRole("listitem")).toHaveLength(10)
    expect(within(audit).queryByRole("button")).not.toBeInTheDocument()
  })
})
