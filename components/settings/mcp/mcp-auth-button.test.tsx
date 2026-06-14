/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

const authenticateMock = jest.fn()
const clearMock = jest.fn()
const statusMock = jest.fn()
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  mcpOAuthAuthenticate: (...a: unknown[]) => authenticateMock(...a),
  mcpOAuthClear: (...a: unknown[]) => clearMock(...a),
  mcpOAuthStatus: (...a: unknown[]) => statusMock(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { isTauri } from "@/lib/tauri"
import type { McpServer } from "@/lib/claude/types"
import { McpAuthButton } from "./mcp-auth-button"

const isTauriMock = isTauri as jest.Mock

const messages = {
  mcp: {
    auth: {
      anthropicHeaderNote: "note",
      authenticate: "Authenticate",
      denied: "denied {name}",
      desktopOnly: "desktop only",
      error: "error {name} {message}",
      reauthenticate: "Re-authenticate",
      signOut: "Sign out",
      statusAuthorized: "Authorized",
      statusExpired: "Expired",
      statusNone: "Not signed in",
      success: "{name} ok",
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

const server = (transport: McpServer["transport"]): McpServer =>
  ({ id: "s", name: "Remote", transport, config: { url: "https://x" }, enabled: true }) as McpServer

beforeEach(() => {
  authenticateMock.mockReset()
  clearMock.mockReset()
  statusMock.mockReset()
  isTauriMock.mockReturnValue(true)
})

describe("McpAuthButton", () => {
  it("renders nothing for stdio servers", () => {
    const { container } = wrap(<McpAuthButton server={server("stdio")} />)
    expect(container.querySelector('[data-testid="mcp-auth-button"]')).toBeNull()
  })

  it("shows 'Not signed in' + Authenticate for a tokenless remote server", async () => {
    statusMock.mockResolvedValue({ hasTokens: false })
    wrap(<McpAuthButton server={server("http")} />)
    expect(await screen.findByText("Not signed in")).toBeInTheDocument()
    expect(screen.getByText("Authenticate")).toBeInTheDocument()
    expect(screen.queryByLabelText("Sign out")).toBeNull()
  })

  it("shows Authorized + Re-authenticate + Sign out when a token exists", async () => {
    statusMock.mockResolvedValue({ hasTokens: true, expiresAtMs: Date.now() + 100_000 })
    wrap(<McpAuthButton server={server("http")} />)
    expect(await screen.findByText("Authorized")).toBeInTheDocument()
    expect(screen.getByText("Re-authenticate")).toBeInTheDocument()
    expect(screen.getByLabelText("Sign out")).toBeInTheDocument()
  })

  it("calls authenticate with the server descriptor and refetches", async () => {
    statusMock.mockResolvedValueOnce({ hasTokens: false })
    authenticateMock.mockResolvedValue({ ok: true, status: "authorized", message: "ok" })
    statusMock.mockResolvedValueOnce({ hasTokens: true, expiresAtMs: Date.now() + 100_000 })
    wrap(<McpAuthButton server={server("http")} />)
    fireEvent.click(await screen.findByText("Authenticate"))
    await waitFor(() =>
      expect(authenticateMock).toHaveBeenCalledWith("Remote", {
        transport: "http",
        config: { url: "https://x" },
      })
    )
  })

  it("signs out via mcpOAuthClear", async () => {
    statusMock.mockResolvedValue({ hasTokens: true, expiresAtMs: Date.now() + 100_000 })
    clearMock.mockResolvedValue(undefined)
    wrap(<McpAuthButton server={server("http")} />)
    fireEvent.click(await screen.findByLabelText("Sign out"))
    await waitFor(() => expect(clearMock).toHaveBeenCalledWith("Remote"))
  })
})
