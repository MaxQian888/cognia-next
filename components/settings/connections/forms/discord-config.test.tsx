/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-discord-id" })
const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
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
  connectorsKeyringGet: (...args: unknown[]) => mockKeyringGet(...args),
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
  connectorsKeyringList: (...args: unknown[]) => mockKeyringList(...args),
}))

const hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...args: unknown[]) => mockCapability(...args),
  useHostProfile: () => hostProfile,
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

/**
 * Save is disabled while the credential read is in flight: until it lands the
 * form does not know its own baseline.
 */
async function clickSave(): Promise<void> {
  const save = screen.getByRole("button", { name: /save/i })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
}

beforeEach(() => {
  mockCapability.mockReturnValue(true)
  // An EXISTING row means a bot whose credentials are in the keyring — that is
  // what the form reads back, and what `missingRequired` checks a save against.
  // Tests about an absent credential override this per case.
  mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
    name === "botToken" ? "stored-bot-token" : name === "publicKey" ? "stored-public-key" : null
  )
  mockKeyringList.mockResolvedValue([])
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
      mediaModelPolicy: "local_extract_only",
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
    mediaModelPolicy: "local_extract_only",
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
    await clickSave()

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
    await clickSave()

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

describe("DiscordConfigDialog — credential prefill", () => {
  const prefillRow = {
    id: "dc-1",
    type: "discord",
    displayName: "Existing",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["botToken", "publicKey"],
    },
    trigger: {},
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 2,
  } as unknown as AdapterInstanceRow

  function openExisting() {
    return render(<DiscordConfigDialog open onOpenChange={jest.fn()} row={prefillRow} />)
  }

  function storedCredentials() {
    mockKeyringGet.mockImplementation(async (_id: string, name: string) => {
      if (name === "botToken") return "s3cret"
      if (name === "publicKey") return "ed25519pub"
      return null
    })
  }

  it("reads the stored credentials back into the fields", async () => {
    storedCredentials()
    openExisting()

    const secret = screen.getByLabelText(/bot token/i) as HTMLInputElement
    await waitFor(() => expect(secret.value).toBe("s3cret"))
    expect(secret.type).toBe("password")
  })

  // Prefilling puts real values in previously-empty boxes; the form must not
  // read that as the operator having typed them.
  it("does not look edited just because the values were read back", async () => {
    storedCredentials()
    openExisting()
    await waitFor(() =>
      expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe("s3cret")
    )
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
  })

  it("says the value is saved-but-unreadable when the host refuses the read", async () => {
    mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
    openExisting()

    await waitFor(() =>
      expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
    )
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe("")
    // A blank box nobody could read must never be taken for a deletion.
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })
})
