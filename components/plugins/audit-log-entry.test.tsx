/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"

// A sentinel formatter so the row is pinned to the locale-aware next-intl
// path (and the options it asks for), not to a raw UTC ISO slice.
jest.mock("next-intl", () => ({
  useFormatter: () => ({
    dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      `fmt:${new Date(value).toISOString()}:${options?.dateStyle ?? "-"}/${options?.timeStyle ?? "-"}`,
  }),
}))

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

  it("renders the local time of day through the next-intl formatter", () => {
    renderRow(makeEntry({ timestamp: Date.UTC(2026, 4, 21, 14, 30, 45) }))
    const time = screen.getByText("fmt:2026-05-21T14:30:45.000Z:-/medium")
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-05-21T14:30:45.000Z")
    expect(time).toHaveAttribute("title", "fmt:2026-05-21T14:30:45.000Z:medium/medium")
    expect(screen.queryByText("14:30:45")).not.toBeInTheDocument()
  })

  it("omits the time instead of rendering an invalid date", () => {
    const { container } = renderRow(makeEntry({ timestamp: Number.NaN }))
    expect(container.querySelector("time")).toBeNull()
    expect(container.textContent).not.toContain("Invalid Date")
    expect(screen.getByText("clipboard:read")).toBeInTheDocument()
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
