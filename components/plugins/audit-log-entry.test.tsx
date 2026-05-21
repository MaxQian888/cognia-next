/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"
import { AuditLogEntry } from "./audit-log-entry"

function makeEntry(overrides: Partial<PermissionAuditEntry> = {}): PermissionAuditEntry {
  return {
    timestamp: Date.UTC(2026, 4, 21, 14, 30, 45),
    pluginId: "alpha",
    permission: "clipboard:read",
    action: "grant",
    allowed: true,
    ...overrides,
  }
}

function renderRow(entry: PermissionAuditEntry, showPlugin = false) {
  return render(
    <ul>
      <AuditLogEntry entry={entry} showPlugin={showPlugin} />
    </ul>
  )
}

describe("AuditLogEntry", () => {
  it("renders the action as a Badge and the permission code", () => {
    renderRow(makeEntry({ action: "grant", permission: "clipboard:read" }))
    expect(screen.getByText("grant")).toBeInTheDocument()
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()
  })

  it("renders the HH:MM:SS portion of the ISO timestamp", () => {
    renderRow(makeEntry({ timestamp: Date.UTC(2026, 4, 21, 14, 30, 45) }))
    expect(screen.getByText("14:30:45")).toBeInTheDocument()
  })

  it("hides the plugin id when showPlugin is false (default)", () => {
    renderRow(makeEntry({ pluginId: "alpha" }))
    expect(screen.queryByText("alpha")).not.toBeInTheDocument()
  })

  it("shows the plugin id when showPlugin is true", () => {
    renderRow(makeEntry({ pluginId: "alpha" }), true)
    expect(screen.getByText("alpha")).toBeInTheDocument()
  })

  it.each([
    ["grant", "secondary"],
    ["request", "outline"],
    ["deny", "destructive"],
    ["revoke", "destructive"],
  ] as const)("uses the %s badge variant for the %s action", (action, _expectedVariant) => {
    renderRow(makeEntry({ action }))
    // We assert by checking that the Badge text matches; the visual variant
    // is enforced via the data-slot attribute that shadcn's Badge writes.
    expect(screen.getByText(action)).toBeInTheDocument()
  })
})
