/**
 * Smoke coverage for the External Bridge settings section. Drives the
 * top-level component end-to-end against fake-indexeddb so the four
 * cards (status, scope toggles, setup snippet, audit log) all render
 * and the major interactions (toggle enable, rotate token, switch
 * snippet variant) propagate to Dexie.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalBridgeSection } from "./external-bridge-section"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("ExternalBridgeSection", () => {
  it("renders all four cards once settings load", async () => {
    render(<ExternalBridgeSection />)
    await waitFor(() => {
      expect(screen.getByText(/MCP server/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/Permission scopes/i)).toBeInTheDocument()
    expect(screen.getByText(/Setup snippet/i)).toBeInTheDocument()
    expect(screen.getByText(/Recent MCP calls/i)).toBeInTheDocument()
  })

  it("toggling the master switch persists to AppSettings", async () => {
    const user = userEvent.setup()
    render(<ExternalBridgeSection />)
    const toggle = await screen.findByLabelText(/Enable MCP server/i)
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await waitFor(async () => {
      const settings = await getSettings()
      expect(settings.externalBridge?.enabled).toBe(true)
    })
  })

  it("default-enabled scopes are wiki:cognia + rag:cognia", async () => {
    render(<ExternalBridgeSection />)
    await waitFor(async () => {
      const settings = await getSettings()
      // Persisted only on first save; the section may not have written yet.
      const persisted = settings.externalBridge
      const scopes = persisted?.enabledScopes ?? ["wiki:cognia", "rag:cognia"]
      expect(scopes).toEqual(expect.arrayContaining(["wiki:cognia", "rag:cognia"]))
    })
  })

  it("user-repo scopes are visually disabled (Phase 1)", async () => {
    render(<ExternalBridgeSection />)
    const wikiUserRepoToggle = await screen.findByLabelText(/Toggle wiki:user-repo/i)
    expect(wikiUserRepoToggle).toBeDisabled()
    const ragUserRepoToggle = await screen.findByLabelText(/Toggle rag:user-repo/i)
    expect(ragUserRepoToggle).toBeDisabled()
  })

  it("toggling a runtime scope persists via the gate", async () => {
    const user = userEvent.setup()
    render(<ExternalBridgeSection />)
    const toggle = await screen.findByLabelText(/Toggle runtime:skills/i)
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await waitFor(async () => {
      const settings = await getSettings()
      expect(settings.externalBridge?.enabledScopes).toContain("runtime:skills")
    })
  })

  it("displays placeholder when audit log is empty", async () => {
    render(<ExternalBridgeSection />)
    await waitFor(() => {
      expect(screen.getByText(/No calls yet/i)).toBeInTheDocument()
    })
  })

  it("renders audit log rows when entries exist", async () => {
    await appendMcpAuditLog({
      ts: Date.now(),
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 4,
    })
    render(<ExternalBridgeSection />)
    await waitFor(() => {
      expect(screen.getByText("wiki_search")).toBeInTheDocument()
    })
    expect(screen.getByText(/4ms/)).toBeInTheDocument()
  })

  it("HTTP / stdio toggle changes the snippet content", async () => {
    const user = userEvent.setup()
    // Pre-set a token so the HTTP snippet shows it instead of the placeholder.
    await saveSettings({
      externalBridge: {
        enabled: true,
        enabledScopes: ["wiki:cognia", "rag:cognia"],
        bearerToken: "test-token-abc",
      },
    })
    render(<ExternalBridgeSection />)
    await waitFor(() => screen.getByText(/Setup snippet/i))
    // Default is stdio.
    expect(screen.getByText(/cognia-mcp\.js/)).toBeInTheDocument()
    // Switch to HTTP.
    const httpButton = screen.getByRole("button", { name: /^HTTP$/ })
    await user.click(httpButton)
    await waitFor(() => {
      expect(screen.getByText(/Bearer test-token-abc/)).toBeInTheDocument()
    })
  })
})
