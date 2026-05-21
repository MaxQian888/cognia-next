/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockAuditLog: PermissionAuditEntry[] = []

jest.mock("@/hooks/plugins", () => ({
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
})
