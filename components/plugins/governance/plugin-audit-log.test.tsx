/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"

jest.mock("next-intl", () => ({
  useLocale: () => "zh-CN",
  useTranslations: () => (key: string) => key,
  // Rows render their time through `<AuditLogEntry>`'s next-intl formatter.
  useFormatter: () => ({
    dateTime: (value: Date | number) => `fmt:${new Date(value).toISOString()}`,
  }),
}))

let mockAuditLog: PermissionAuditEntry[] = []
// "alpha" is installed with a zh-CN name; "beta" is no longer installed.
const mockInstalled = [
  {
    id: "alpha",
    name: "Alpha",
    manifest: {
      nameKey: "plugin.name",
      i18n: { locales: { "zh-CN": { "plugin.name": "阿尔法" } } },
    },
  },
]

jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => ({ all: mockInstalled, loading: false }),
  usePluginPermissions: () => ({
    groups: {},
    dangerous: [],
    descriptions: {},
    getGranted: jest.fn(() => []),
    getHolders: jest.fn(() => []),
    auditLog: mockAuditLog,
    grant: jest.fn(),
    revoke: jest.fn(),
    revokeAll: jest.fn(),
    request: jest.fn(),
    isDangerous: jest.fn(() => false),
    getTier: jest.fn(() => "silent"),
    setTier: jest.fn(),
    getTiersForPlugin: jest.fn(() => []),
  }),
}))

import { PluginAuditLog } from "./plugin-audit-log"

beforeEach(() => {
  mockAuditLog = [
    {
      timestamp: Date.UTC(2026, 0, 1, 10, 0, 0),
      pluginId: "alpha",
      permission: "clipboard:read",
      action: "grant",
      allowed: true,
    },
    {
      timestamp: Date.UTC(2026, 0, 1, 10, 5, 0),
      pluginId: "beta",
      permission: "network:fetch",
      action: "deny",
      allowed: false,
    },
    {
      timestamp: Date.UTC(2026, 0, 1, 10, 10, 0),
      pluginId: "alpha",
      permission: "shell:execute",
      action: "revoke",
      allowed: false,
    },
  ]
})

describe("PluginAuditLog", () => {
  it("renders one row per audit entry (newest first)", () => {
    render(<PluginAuditLog />)
    const list = screen.getByTestId("plugin-audit-log-list")
    expect(list.querySelectorAll("li").length).toBe(3)
    // Localized through the formatter, machine-readable ISO kept on <time>.
    const times = Array.from(list.querySelectorAll("time"))
    expect(times.map((el) => el.getAttribute("dateTime"))).toEqual([
      "2026-01-01T10:10:00.000Z",
      "2026-01-01T10:05:00.000Z",
      "2026-01-01T10:00:00.000Z",
    ])
    expect(times[0]).toHaveTextContent("fmt:2026-01-01T10:10:00.000Z")
  })

  it("renders the empty state when there are no entries", () => {
    mockAuditLog = []
    render(<PluginAuditLog />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("disables the export button when no entries pass the filter", () => {
    mockAuditLog = []
    render(<PluginAuditLog />)
    expect(screen.getByTestId("plugin-audit-export")).toBeDisabled()
  })

  it("triggers a CSV download when export is clicked with non-empty entries", () => {
    const createObjectURL = jest.fn(() => "blob:url")
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true })
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true })

    render(<PluginAuditLog />)
    fireEvent.click(screen.getByTestId("plugin-audit-export"))
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:url")
  })

  it("renders both filter selects", () => {
    render(<PluginAuditLog />)
    expect(screen.getByTestId("plugin-audit-filter-plugin")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-audit-filter-permission")).toBeInTheDocument()
  })

  it("names installed plugins by their localized name, and falls back to the id", () => {
    render(<PluginAuditLog />)
    const list = screen.getByTestId("plugin-audit-log-list")
    expect(within(list).getAllByText("阿尔法")).toHaveLength(2)
    expect(within(list).getByText("beta")).toBeInTheDocument()
    expect(within(list).queryByText("alpha")).not.toBeInTheDocument()
  })

  it("lists the entries flat, with no card and no inner scroller", () => {
    const { container } = render(<PluginAuditLog />)
    expect(container.querySelector("[data-slot='card']")).toBeNull()
    expect(container.querySelector("[data-slot='scroll-area']")).toBeNull()
    expect(screen.getByTestId("plugin-audit-log")).toHaveClass("@container")
  })
})
