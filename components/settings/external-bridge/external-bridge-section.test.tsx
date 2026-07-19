/**
 * Smoke coverage for the External Bridge settings section. Drives the
 * top-level component end-to-end against fake-indexeddb so the four
 * cards (status, scope toggles, setup snippet, audit log) all render
 * and the major interactions (toggle enable, rotate token, switch
 * snippet variant) propagate to Dexie.
 */

import "fake-indexeddb/auto"
let mockMcpHostAvailable = false
const mockStartMcpServer = jest.fn(async (_args: unknown) => 47890)
const mockStopMcpServer = jest.fn(async () => undefined)
jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: () => mockMcpHostAvailable,
}))
jest.mock("@/lib/external-bridge/tauri-control", () => ({
  getMcpServerStatus: jest.fn(async () => ({
    running: false,
    port: null,
    startedAt: null,
  })),
  startMcpServer: (...args: unknown[]) => mockStartMcpServer(args[0]),
  stopMcpServer: () => mockStopMcpServer(),
}))
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { ALL_BRIDGE_SCOPES } from "@/types/wiki"
import { ExternalBridgeSection } from "./external-bridge-section"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"

beforeEach(async () => {
  mockMcpHostAvailable = false
  mockStartMcpServer.mockClear()
  mockStopMcpServer.mockClear()
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

  it("starts the process-owned MCP server when a remote host supplies the capability", async () => {
    mockMcpHostAvailable = true
    const user = userEvent.setup()
    render(<ExternalBridgeSection />)

    await user.click(await screen.findByLabelText(/Enable MCP server/i))

    await waitFor(() => expect(mockStartMcpServer).toHaveBeenCalledTimes(1))
    expect(mockStartMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 0, settings: expect.objectContaining({ enabled: true }) })
    )
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

  it("the snippet client picker switches between Claude Desktop stdio/HTTP variants", async () => {
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
    // Default is "Claude Desktop (stdio)".
    expect(screen.getByText(/cognia-mcp\.js/)).toBeInTheDocument()
    // Switch to "Claude Desktop (HTTP)" via the client picker.
    const picker = screen.getByRole("combobox", { name: /Client/i })
    await user.click(picker)
    const httpOption = await screen.findByRole("option", { name: /Claude Desktop \(HTTP\)/i })
    await user.click(httpOption)
    await waitFor(() => {
      expect(screen.getByText(/Bearer test-token-abc/)).toBeInTheDocument()
    })
  })

  it("offers Cursor and Goose snippets in addition to Claude Desktop", async () => {
    const user = userEvent.setup()
    await saveSettings({
      externalBridge: {
        enabled: true,
        enabledScopes: ["wiki:cognia", "rag:cognia"],
        bearerToken: "test-token-abc",
      },
    })
    render(<ExternalBridgeSection />)
    await waitFor(() => screen.getByText(/Setup snippet/i))
    const picker = screen.getByRole("combobox", { name: /Client/i })
    await user.click(picker)
    expect(await screen.findByRole("option", { name: /Cursor/i })).toBeInTheDocument()
    expect(await screen.findByRole("option", { name: /Goose/i })).toBeInTheDocument()
  })

  it("rotating the bearer token requires confirmation before regenerating", async () => {
    const user = userEvent.setup()
    await saveSettings({
      externalBridge: {
        enabled: true,
        enabledScopes: ["wiki:cognia", "rag:cognia"],
        bearerToken: "test-token-abc",
      },
    })
    render(<ExternalBridgeSection />)

    // Cancelling the confirm dialog leaves the current token untouched.
    await user.click(await screen.findByRole("button", { name: /^Rotate token$/i }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/Rotate bearer token\?/i)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: /Cancel/i }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect((await getSettings()).externalBridge?.bearerToken).toBe("test-token-abc")

    // Confirming regenerates the token (new 64-char hex value, different value).
    await user.click(await screen.findByRole("button", { name: /^Rotate token$/i }))
    const dialog2 = await screen.findByRole("alertdialog")
    await user.click(within(dialog2).getByRole("button", { name: /^Rotate token$/i }))
    await waitFor(async () => {
      const next = (await getSettings()).externalBridge?.bearerToken
      expect(next).toMatch(/^[0-9a-f]{64}$/)
      expect(next).not.toBe("test-token-abc")
    })
  })

  it("the rotate-token button is disabled until a token exists", async () => {
    render(<ExternalBridgeSection />)
    const rotate = await screen.findByRole("button", { name: /^Rotate token$/i })
    expect(rotate).toBeDisabled()
  })

  it("clearing the audit log requires confirmation and wires to clearMcpAuditLog", async () => {
    const user = userEvent.setup()
    await appendMcpAuditLog({
      ts: Date.now(),
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 4,
    })
    render(<ExternalBridgeSection />)
    const clearButton = await screen.findByRole("button", { name: /Clear audit log/i })
    await user.click(clearButton)
    // Confirmation dialog renders.
    expect(await screen.findByText(/Clear MCP audit log/i)).toBeInTheDocument()
    const confirm = screen.getByRole("button", { name: /^Clear log$/i })
    await user.click(confirm)
    await waitFor(() => {
      expect(screen.getByText(/No calls yet/i)).toBeInTheDocument()
    })
  })
})

describe("scope description i18n parity", () => {
  // Every scope in ALL_BRIDGE_SCOPES is rendered through
  // t(`scopeDescriptions.${scope}`) — a missing key throws MISSING_MESSAGE
  // at runtime, so pin the message files to the scope list here.
  const locales = [
    ["en", enMessages],
    ["zh-CN", zhMessages],
  ] as const

  it.each(locales)(
    "%s has a scopeDescriptions entry for every bridge scope",
    (_locale, messages) => {
      const descriptions = messages.settings.externalBridge.scopeDescriptions as Record<
        string,
        string
      >
      for (const scope of ALL_BRIDGE_SCOPES) {
        expect(descriptions[scope]).toEqual(expect.any(String))
        expect(descriptions[scope]).not.toBe("")
      }
    }
  )
})
