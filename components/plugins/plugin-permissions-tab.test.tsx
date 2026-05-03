/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginPermission } from "@/types/plugin"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockUsePlugins = jest.fn()
const mockUsePluginPermissions = jest.fn()
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockUsePlugins(),
  usePluginPermissions: () => mockUsePluginPermissions(),
}))

const openPermissionReview = jest.fn()
jest.mock("@/stores/plugins", () => ({
  usePluginsStore: (selector: (s: unknown) => unknown) => selector({ openPermissionReview }),
}))

import { PluginPermissionsTab } from "./plugin-permissions-tab"

function makeRow(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "p1",
    name: "Plugin One",
    version: "1.0.0",
    status: "enabled",
    source: "local",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/p1",
    manifest: {},
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const PERMS_API = {
  dangerous: ["shell:execute", "filesystem:write"] as PluginPermission[],
  groups: {},
  descriptions: {},
  getGranted: jest.fn<PluginPermission[], [string]>(() => []),
  getHolders: jest.fn<string[], [PluginPermission]>(() => []),
  auditLog: [],
  grant: jest.fn(),
  revoke: jest.fn(),
  revokeAll: jest.fn(),
  request: jest.fn(),
  isDangerous: jest.fn(),
}

describe("PluginPermissionsTab", () => {
  beforeEach(() => {
    openPermissionReview.mockClear()
    mockUsePlugins.mockReset()
    mockUsePluginPermissions.mockReset()
    PERMS_API.getGranted.mockReset()
    PERMS_API.getGranted.mockReturnValue([])
    mockUsePluginPermissions.mockReturnValue(PERMS_API)
  })

  it("renders loading state", () => {
    mockUsePlugins.mockReturnValue({ all: [], loading: true })
    render(<PluginPermissionsTab />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders empty state when no plugins installed", () => {
    mockUsePlugins.mockReturnValue({ all: [], loading: false })
    render(<PluginPermissionsTab />)
    expect(screen.getByText("emptyAll")).toBeInTheDocument()
  })

  it("renders no-permissions card when plugins exist but none declare permissions", () => {
    mockUsePlugins.mockReturnValue({
      all: [makeRow({ id: "a", name: "Alpha", manifest: {} })],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    expect(screen.getByText("noPermissions")).toBeInTheDocument()
  })

  it("groups permissions into dangerous and standard sections", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "a",
          name: "Alpha",
          manifest: { permissions: ["shell:execute", "clipboard:read"] },
        }),
        makeRow({
          id: "b",
          name: "Bravo",
          manifest: { permissions: ["clipboard:read"] },
        }),
      ],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    expect(screen.getByText("dangerousSection")).toBeInTheDocument()
    expect(screen.getByText("normalSection")).toBeInTheDocument()
    expect(screen.getByText("shell:execute")).toBeInTheDocument()
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()
  })

  it("counts holders correctly across declared, optional, and granted", () => {
    PERMS_API.getGranted.mockImplementation((id: string) =>
      id === "b" ? (["clipboard:read"] as PluginPermission[]) : []
    )
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "a",
          name: "Alpha",
          manifest: { permissions: ["clipboard:read"] },
        }),
        makeRow({
          id: "b",
          name: "Bravo",
          manifest: { optionalPermissions: ["clipboard:read"] },
        }),
      ],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    // Alpha + Bravo both render as chips for clipboard:read
    const alphaChips = screen.getAllByLabelText(/reviewAria.*Alpha/)
    const bravoChips = screen.getAllByLabelText(/reviewAria.*Bravo/)
    // Each plugin gets one chip in BulkReview + one chip per permission they hold.
    expect(alphaChips.length).toBeGreaterThanOrEqual(2)
    expect(bravoChips.length).toBeGreaterThanOrEqual(2)
  })

  it("clicking a plugin chip in matrix opens permission review for that plugin", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "alpha-id",
          name: "Alpha",
          manifest: { permissions: ["clipboard:read"] },
        }),
      ],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    const chip = screen.getAllByLabelText(/reviewAria.*Alpha/)[0]
    fireEvent.click(chip)
    expect(openPermissionReview).toHaveBeenCalledWith("alpha-id")
  })

  it("Bulk review surface lists every installed plugin", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({ id: "a", name: "Alpha" }),
        makeRow({ id: "b", name: "Bravo" }),
        makeRow({ id: "c", name: "Charlie" }),
      ],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    expect(screen.getByText("bulkHeading")).toBeInTheDocument()
    const bulkButtons = screen.getAllByLabelText(/reviewAria/)
    expect(bulkButtons.length).toBeGreaterThanOrEqual(3)
  })

  it("does not duplicate holders if same permission appears in declared+granted", () => {
    PERMS_API.getGranted.mockReturnValue(["clipboard:read"] as PluginPermission[])
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "a",
          name: "Alpha",
          manifest: { permissions: ["clipboard:read"] },
        }),
      ],
      loading: false,
    })
    render(<PluginPermissionsTab />)
    // Within the matrix table cell, only one Alpha chip should appear next to clipboard:read.
    const row = screen.getByText("clipboard:read").closest("tr")!
    const alphaChips = row.querySelectorAll("button[aria-label*='Alpha']")
    expect(alphaChips.length).toBe(1)
  })
})
