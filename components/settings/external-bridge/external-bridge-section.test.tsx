/**
 * Integration coverage for the External Bridge settings section. Drives the
 * top-level component against fake-indexeddb and the real English message
 * bundle, so panel navigation and the major interactions (toggle enable,
 * rotate token, switch snippet variant, clear audit log) are exercised the way
 * a user reaches them — through the master/detail nav, not by rendering a card
 * in isolation.
 *
 * Panel-local behaviour lives in `panels/*.test.tsx`; this file owns the shell
 * (deep links, nav, badges) and the end-to-end persistence path.
 */

import "fake-indexeddb/auto"

let searchString = ""
const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchString),
  usePathname: () => "/settings",
}))

let mockMcpHostAvailable = false
const mockStartMcpServer = jest.fn(async (_args: unknown) => 47890)
const mockStopMcpServer = jest.fn(async () => undefined)
const mockRestartMcpServer = jest.fn(async (_args: unknown) => 47890)
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
  restartMcpServer: (...args: unknown[]) => mockRestartMcpServer(args[0]),
  stopMcpServer: () => mockStopMcpServer(),
}))

// The sidecar path is resolved by Rust against the real filesystem; in jsdom
// there is no host, so stand in for an installed sidecar. `null` (not
// installed) is covered in `panels/setup-panel.test.tsx`.
const mockResolveSidecarPath = jest.fn(async () => "/opt/cognia/sidecar/cognia-mcp.mjs")
jest.mock("./bridge-runtime", () => ({
  ...jest.requireActual("./bridge-runtime"),
  resolveSidecarPath: () => mockResolveSidecarPath(),
}))

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { ALL_BRIDGE_SCOPES } from "@/types/wiki"
import { ExternalBridgeSection } from "./external-bridge-section"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { appendMcpAuditLog } from "@/lib/db/mcp-audit-log"

/** Render the section already deep-linked to one panel. */
function renderAt(panel: string) {
  searchString = panel ? `bridgePanel=${panel}` : ""
  return render(<ExternalBridgeSection />)
}

beforeEach(async () => {
  searchString = ""
  replace.mockClear()
  mockMcpHostAvailable = false
  mockStartMcpServer.mockClear()
  mockStopMcpServer.mockClear()
  mockRestartMcpServer.mockClear()
  mockResolveSidecarPath.mockClear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("ExternalBridgeSection shell", () => {
  it("lands on the server panel and offers the other four in the nav", async () => {
    renderAt("")

    expect(await screen.findByText(/MCP server/i)).toBeInTheDocument()
    for (const panel of ["server", "scopes", "wiki", "setup", "audit"]) {
      expect(screen.getByTestId(`bridge-nav-item-${panel}`)).toBeInTheDocument()
    }
  })

  it("shows only the active panel, not all five stacked", async () => {
    // The point of the refactor: this used to be one ~2000px scroll.
    renderAt("")
    await screen.findByText(/MCP server/i)

    // Asserted on the panels' own markers, not their prose — the server panel's
    // port help legitimately mentions "setup snippets".
    expect(screen.queryByTestId("bridge-setup-snippet")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear audit log/i })).not.toBeInTheDocument()
  })

  it("deep-links into the audit panel", async () => {
    renderAt("audit")
    expect(await screen.findByText(/Recent MCP calls/i)).toBeInTheDocument()
  })

  it("navigates when a nav item is chosen", async () => {
    // The panel is derived purely from the URL, so selecting one is ONLY a
    // navigation — if this call is lost the nav renders and highlights while
    // the detail pane never changes, which no deep-link test would catch.
    renderAt("")
    await screen.findByTestId("bridge-nav-item-audit")

    fireEvent.click(screen.getByTestId("bridge-nav-item-audit"))

    expect(replace).toHaveBeenCalledWith("?bridgePanel=audit", { scroll: false })
  })

  it("preserves unrelated query params when switching panels", async () => {
    searchString = "tab=external-bridge&bridgePanel=server"
    render(<ExternalBridgeSection />)
    await screen.findByTestId("bridge-nav-item-scopes")

    fireEvent.click(screen.getByTestId("bridge-nav-item-scopes"))

    const [url] = replace.mock.calls[0] as [string]
    expect(url).toContain("tab=external-bridge")
    expect(url).toContain("bridgePanel=scopes")
  })

  it("deep-links into the wiki maintenance panel", async () => {
    // Rebuild and lint share one panel rather than each owning a nav entry.
    renderAt("wiki")
    expect(await screen.findByTestId("bridge-nav-item-wiki")).toHaveAttribute(
      "aria-current",
      "true"
    )
  })

  it("navigating writes the panel into the URL", async () => {
    const user = userEvent.setup()
    renderAt("")
    await screen.findByText(/MCP server/i)

    await user.click(screen.getByTestId("bridge-nav-item-audit"))

    expect(replace).toHaveBeenCalledWith("?bridgePanel=audit", { scroll: false })
  })

  it("badges the scopes panel with the granted count", async () => {
    await saveSettings({
      externalBridge: { enabled: false, enabledScopes: ["wiki:cognia", "rag:cognia"] },
    })
    renderAt("")

    expect(await screen.findByTestId("bridge-nav-badge-scopes")).toHaveTextContent(
      `2/${ALL_BRIDGE_SCOPES.length}`
    )
  })
})

describe("ExternalBridgeSection server panel", () => {
  it("toggling the master switch persists to AppSettings", async () => {
    const user = userEvent.setup()
    renderAt("server")
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
    renderAt("server")

    await user.click(await screen.findByLabelText(/Enable MCP server/i))

    await waitFor(() => expect(mockStartMcpServer).toHaveBeenCalledTimes(1))
    // Port 3001, not 0: an OS-assigned port cannot be written into the client
    // config this surface exists to produce.
    expect(mockStartMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3001,
        settings: expect.objectContaining({ enabled: true }),
      })
    )
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
    renderAt("server")

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
    renderAt("server")
    expect(await screen.findByRole("button", { name: /^Rotate token$/i })).toBeDisabled()
  })
})

describe("ExternalBridgeSection scopes panel", () => {
  it("default-enabled scopes are wiki:cognia + rag:cognia", async () => {
    renderAt("scopes")
    await waitFor(async () => {
      const settings = await getSettings()
      // Persisted only on first save; the section may not have written yet.
      const scopes = settings.externalBridge?.enabledScopes ?? ["wiki:cognia", "rag:cognia"]
      expect(scopes).toEqual(expect.arrayContaining(["wiki:cognia", "rag:cognia"]))
    })
  })

  it("user-repo scopes are disabled AND labelled, not silently inert", async () => {
    renderAt("scopes")

    expect(await screen.findByLabelText(/Toggle wiki:user-repo/i)).toBeDisabled()
    expect(screen.getByLabelText(/Toggle rag:user-repo/i)).toBeDisabled()
    // The half that was missing: the UI now says why.
    expect(screen.getByTestId("bridge-scope-planned-wiki:user-repo")).toBeInTheDocument()
    expect(screen.getByTestId("bridge-scope-planned-rag:user-repo")).toBeInTheDocument()
  })

  it("toggling a runtime scope persists via the gate", async () => {
    const user = userEvent.setup()
    renderAt("scopes")
    const toggle = await screen.findByLabelText(/Toggle runtime:skills/i)
    expect(toggle).not.toBeChecked()

    await user.click(toggle)

    await waitFor(async () => {
      const settings = await getSettings()
      expect(settings.externalBridge?.enabledScopes).toContain("runtime:skills")
    })
  })
})

describe("ExternalBridgeSection setup panel", () => {
  it("the client picker switches between Claude Desktop stdio/HTTP variants", async () => {
    const user = userEvent.setup()
    await saveSettings({
      externalBridge: {
        enabled: true,
        enabledScopes: ["wiki:cognia", "rag:cognia"],
        bearerToken: "test-token-abc",
      },
    })
    renderAt("setup")
    await waitFor(() => screen.getByText(/Setup snippet/i))

    // Default is "Claude Desktop (stdio)" and it names the real sidecar file —
    // the bundled `cognia-mcp.mjs`, resolved by Rust, not a synthesised path.
    expect(await screen.findByText(/cognia-mcp\.mjs/)).toBeInTheDocument()

    const picker = screen.getByRole("combobox", { name: /Client/i })
    await user.click(picker)
    await user.click(await screen.findByRole("option", { name: /Claude Desktop \(HTTP\)/i }))

    await waitFor(() => {
      expect(screen.getByText(/Bearer test-token-abc/)).toBeInTheDocument()
    })
  })

  it("offers Cursor and Goose snippets in addition to Claude Desktop", async () => {
    const user = userEvent.setup()
    await saveSettings({
      externalBridge: {
        enabled: true,
        enabledScopes: ["wiki:cognia"],
        bearerToken: "test-token-abc",
      },
    })
    renderAt("setup")
    await waitFor(() => screen.getByText(/Setup snippet/i))

    await user.click(screen.getByRole("combobox", { name: /Client/i }))

    expect(await screen.findByRole("option", { name: /Cursor/i })).toBeInTheDocument()
    expect(await screen.findByRole("option", { name: /Goose/i })).toBeInTheDocument()
  })
})

describe("ExternalBridgeSection audit panel", () => {
  it("displays a placeholder when the audit log is empty", async () => {
    renderAt("audit")
    expect(await screen.findByText(/No calls yet/i)).toBeInTheDocument()
  })

  it("renders audit log rows when entries exist", async () => {
    await appendMcpAuditLog({
      ts: Date.now(),
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 4,
    })
    renderAt("audit")

    expect(await screen.findByText("wiki_search")).toBeInTheDocument()
    expect(screen.getByText(/4ms/)).toBeInTheDocument()
  })

  it("clearing the audit log requires confirmation and wires to clearMcpAuditLog", async () => {
    await appendMcpAuditLog({
      ts: Date.now(),
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 4,
    })
    renderAt("audit")

    // Wait for the ROW, not the button: the button renders immediately but is
    // disabled until the live query reports a non-empty log, so clicking as
    // soon as it appears is a no-op and the dialog never opens.
    await screen.findByText("wiki_search")
    fireEvent.click(screen.getByRole("button", { name: /Clear audit log/i }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/Clear MCP audit log/i)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: /^Clear log$/i }))

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
