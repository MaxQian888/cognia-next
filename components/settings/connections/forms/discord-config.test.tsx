/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-discord-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsHttpRequest = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsHttpRequest: (...args: unknown[]) => mockConnectorsHttpRequest(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

const mockTunnel = { running: false, url: null as string | null, loading: false }
jest.mock("@/hooks/use-tunnel-status", () => ({ useTunnelStatus: () => mockTunnel }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { DiscordConfigDialog } from "./discord-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

function makeMockGetCurrentUserResponse(ok: boolean, username = "testbot", id = "123") {
  return {
    status: ok ? 200 : 401,
    headers: {},
    body: ok
      ? JSON.stringify({ id, username })
      : JSON.stringify({ code: 0, message: "401: Unauthorized" }),
  } satisfies TauriHttpResponse
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTunnel.running = false
  mockTunnel.url = null
  mockTunnel.loading = false
})

/** Flip the transport Select from Gateway (default) to the webhook mode. */
async function switchToWebhook() {
  fireEvent.click(screen.getByRole("combobox"))
  await waitFor(() =>
    expect(screen.getByRole("option", { name: /interactions webhook/i })).toBeInTheDocument()
  )
  fireEvent.click(screen.getByRole("option", { name: /interactions webhook/i }))
}

// ---------------------------------------------------------------------------
// Tests — create new
// ---------------------------------------------------------------------------

describe("DiscordConfigDialog — create new", () => {
  it("renders 'Add Discord Bot' title when open + no row", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add discord bot/i)).toBeInTheDocument()
  })

  it("renders a Bot Token input field", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument()
  })

  it("renders the Test connection button", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument()
  })

  it("hides the Public Key field in gateway mode (default) and shows intents", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByLabelText(/public key/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/gateway intents/i)).toBeInTheDocument()
  })

  it("reveals the Public Key field + interactions-only note when webhook is selected", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    await switchToWebhook()
    expect(screen.getByLabelText(/public key/i)).toBeInTheDocument()
    expect(screen.getByTestId("dc-webhook-interactions-only-note")).toBeInTheDocument()
    // Gateway-only intents field is hidden in webhook mode.
    expect(screen.queryByLabelText(/gateway intents/i)).not.toBeInTheDocument()
  })

  it("shows success status block after successful Test connection", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(
      makeMockGetCurrentUserResponse(true, "mybot", "999")
    )
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-bot-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("users/@me"),
          headers: expect.objectContaining({ Authorization: "Bot my-bot-token" }),
        })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("mybot"))
    })

    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.getByText(/mybot/)).toBeInTheDocument()
  })

  it("shows error status block on failed Test connection", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeMockGetCurrentUserResponse(false))
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "bad-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  it("calls createAdapterInstance + connectorsKeyringSet on Create", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-valid-token" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ type: "discord", transportMode: "gateway" })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-discord-id",
        "botToken",
        "my-valid-token"
      )
    })
  })

  it("persists settings.intents when a valid bitmask is entered", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-token" },
    })
    fireEvent.change(screen.getByLabelText(/gateway intents/i), {
      target: { value: "512" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ type: "discord", settings: { intents: 512 } })
      )
    })
  })

  it("blocks Save when intents is not a non-negative integer", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-token" },
    })
    fireEvent.change(screen.getByLabelText(/gateway intents/i), {
      target: { value: "-4" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("does NOT write publicKey in gateway mode (no ghost credential)", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-discord-id",
        "botToken",
        "my-token"
      )
    })
    const calls = mockConnectorsKeyringSet.mock.calls
    expect(calls.some((args: unknown[]) => args[1] === "publicKey")).toBe(false)
    expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
      expect.objectContaining({ transportMode: "gateway" })
    )
  })

  it("creates a webhook adapter: transportMode + publicKey + accounts", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    await switchToWebhook()

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "my-token" } })
    fireEvent.change(screen.getByLabelText(/public key/i), {
      target: { value: "abcdef1234567890".repeat(4) },
    })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          transportMode: "webhook",
          credentialsRef: expect.objectContaining({ accounts: ["botToken", "publicKey"] }),
        })
      )
    })
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
      "new-discord-id",
      "publicKey",
      "abcdef1234567890".repeat(4)
    )
  })

  it("blocks a webhook create when the Public Key is missing", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    await switchToWebhook()

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "my-token" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("shows the Interactions Endpoint URL card only for an existing webhook adapter with a tunnel", () => {
    mockTunnel.running = true
    mockTunnel.url = "https://tunnel.example.com"
    const webhookRow: AdapterInstanceRow = {
      id: "dc-wh",
      type: "discord",
      displayName: "Webhook Bot",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["botToken", "publicKey"],
      },
      trigger: defaultPrivateChatPolicy(),
      defaultMode: "auto",
      createdAt: 1,
      updatedAt: 2,
    }
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    const urlInput = screen.getByTestId("dc-interactions-url-input") as HTMLInputElement
    expect(urlInput.value).toBe("https://tunnel.example.com/webhook/discord/dc-wh")
  })

  it("does not surface the Interactions endpoint URL in gateway mode", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    // The URL card only renders in webhook mode; gateway shows neither the
    // URL field nor its copy control.
    expect(screen.queryByTestId("dc-interactions-url-input")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /copy interactions endpoint url/i })
    ).not.toBeInTheDocument()
  })

  it("shows error toast when bot token is empty on Save", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — edit existing
// ---------------------------------------------------------------------------

describe("DiscordConfigDialog — edit existing", () => {
  const existingRow: AdapterInstanceRow = {
    id: "dc-existing",
    type: "discord",
    displayName: "Prod Discord Bot",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders 'Configure Discord Bot' title for existing row", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/configure discord bot/i)).toBeInTheDocument()
  })

  it("pre-fills display name from the existing row", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const nameInput = screen.getByDisplayValue("Prod Discord Bot") as HTMLInputElement
    expect(nameInput).toBeInTheDocument()
  })

  it("pre-fills settings.intents and preserves it on Save", async () => {
    const rowWithIntents: AdapterInstanceRow = { ...existingRow, settings: { intents: 4096 } }
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={rowWithIntents} />)

    expect(screen.getByDisplayValue("4096")).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue("Prod Discord Bot"), {
      target: { value: "Renamed Bot" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "dc-existing",
        expect.objectContaining({ settings: { intents: 4096 } })
      )
    })
  })

  it("calls updateAdapterInstance on Save (not create)", async () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod Discord Bot"), {
      target: { value: "Updated Bot" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "dc-existing",
        expect.objectContaining({ displayName: "Updated Bot" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — closed state
// ---------------------------------------------------------------------------

describe("DiscordConfigDialog — closed state", () => {
  it("does not render content when closed", () => {
    render(<DiscordConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText(/add discord bot/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — responsive dialog layout
// ---------------------------------------------------------------------------

describe("DiscordConfigDialog — layout", () => {
  it("caps height and scrolls the body so the sticky footer stays reachable", () => {
    render(<DiscordConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("max-h-[90vh]")
    expect(dialog.className).toContain("flex-col")
    expect(dialog.querySelector('[class*="overflow-y-auto"]')).not.toBeNull()
  })
})
