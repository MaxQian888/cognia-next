/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-adapter-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
const mockConnectorsHttpRequest = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsKeyringGet: (...args: unknown[]) => mockConnectorsKeyringGet(...args),
  connectorsHttpRequest: (...args: unknown[]) => mockConnectorsHttpRequest(...args),
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
  connectorsKeyringList: (...args: unknown[]) => mockKeyringList(...args),
}))

jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...args: unknown[]) => mockCapability(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { TelegramConfigDialog } from "./telegram-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const makeMockGetMeResponse = (ok: boolean, username = "testbot", id = 123) =>
  ({
    status: ok ? 200 : 400,
    headers: {},
    body: ok
      ? JSON.stringify({ ok: true, result: { id, username } })
      : JSON.stringify({ ok: false, description: "Unauthorized" }),
  }) satisfies TauriHttpResponse

/**
 * Save is disabled while the credential read is in flight: until it lands the
 * form cannot tell an absent secret from one it has not read yet.
 */
async function clickSave(): Promise<void> {
  const save = screen.getByRole("button", { name: /save/i })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockCapability.mockReturnValue(true)
  mockConnectorsKeyringGet.mockResolvedValue(null)
  mockKeyringList.mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelegramConfigDialog — create new", () => {
  it("renders the dialog with 'Add Telegram Bot' title when open + no row", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add telegram bot/i)).toBeInTheDocument()
  })

  it("renders a Bot Token input field", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument()
  })

  it("renders the Test connection button", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument()
  })

  it("renders Transport select", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/transport/i)).toBeInTheDocument()
  })

  it("does not render webhook secret field when transport is longpoll", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument()
  })

  it("shows success result block after successful Test connection", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeMockGetMeResponse(true, "mybot", 999))
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    // Enter token
    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "123:ABC" },
    })
    // Click Test
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("getMe") })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("mybot"))
    })

    // Result block should appear
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.getByText(/mybot/)).toBeInTheDocument()
  })

  it("shows error result block on failed Test connection", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeMockGetMeResponse(false))
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "bad-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  it("calls createAdapterInstance + connectorsKeyringSet on Save", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "123:VALIDTOKEN" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ type: "telegram" })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-adapter-id",
        "botToken",
        "123:VALIDTOKEN"
      )
    })
  })

  it("declares only botToken in credentialsRef.accounts for long-poll create", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "123:VALIDTOKEN" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialsRef: expect.objectContaining({
            accounts: ["botToken"],
          }),
        })
      )
    })
  })

  it("declares botToken, secretToken and webhookSecret in credentialsRef.accounts for webhook create", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "123:VALIDTOKEN" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: /transport/i }))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /webhook/i }))
    // Webhook mode requires a secret — the receiver 401s deliveries without one.
    fireEvent.change(screen.getByLabelText(/webhook secret/i), {
      target: { value: "shh-secret" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          transportMode: "webhook",
          credentialsRef: expect.objectContaining({
            accounts: ["botToken", "secretToken", "webhookSecret"],
          }),
        })
      )
    })
  })

  it("saves the webhook secret under 'secretToken' (Rust verifier key) AND legacy 'webhookSecret'", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "123:VALIDTOKEN" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: /transport/i }))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /webhook/i }))

    fireEvent.change(screen.getByLabelText(/webhook secret/i), {
      target: { value: "shh-secret" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      // Rust's verify_telegram reads "secretToken" — the old form only wrote
      // "webhookSecret", so webhook deliveries always 401'd (audited fix #2).
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-adapter-id",
        "secretToken",
        "shh-secret"
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-adapter-id",
        "webhookSecret",
        "shh-secret"
      )
    })
  })

  it("shows error toast when token is empty on Save", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })
})

describe("TelegramConfigDialog — edit existing", () => {
  const existingRow: AdapterInstanceRow = {
    id: "cai_existing",
    type: "telegram",
    displayName: "Prod Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders 'Configure Telegram Bot' title for existing row", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/configure telegram bot/i)).toBeInTheDocument()
  })

  it("pre-fills display name from the existing row", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const nameInput = screen.getByDisplayValue("Prod Bot") as HTMLInputElement
    expect(nameInput).toBeInTheDocument()
  })

  it("calls updateAdapterInstance on Save (not create)", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    // Change display name so we can save
    fireEvent.change(screen.getByDisplayValue("Prod Bot"), {
      target: { value: "Updated Bot" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "cai_existing",
        expect.objectContaining({ displayName: "Updated Bot" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
  })

  it("does not migrate long-poll credentialsRef.accounts to include webhook secret keys", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod Bot"), {
      target: { value: "Long Poll Bot" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalled()
    })
    const patchArg = mockUpdateAdapterInstance.mock.calls[0][1]
    expect(patchArg).not.toHaveProperty("credentialsRef")
  })

  it("migrates credentialsRef.accounts when switching an existing row to webhook", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.click(screen.getByRole("combobox", { name: /transport/i }))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /webhook/i }))
    fireEvent.change(screen.getByLabelText(/webhook secret/i), {
      target: { value: "shh-secret" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "cai_existing",
        expect.objectContaining({
          transportMode: "webhook",
          credentialsRef: expect.objectContaining({
            accounts: ["botToken", "secretToken", "webhookSecret"],
          }),
        })
      )
    })
  })

  it("skips credentialsRef migration for webhook rows when accounts already match", async () => {
    const migratedRow: AdapterInstanceRow = {
      ...existingRow,
      transportMode: "webhook",
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["botToken", "secretToken", "webhookSecret"],
      },
    }
    // Already configured: the secret lives in the keyring, so re-saving must
    // not demand that the operator retype it.
    mockConnectorsKeyringGet.mockResolvedValue("already-stored")
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={migratedRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod Bot"), {
      target: { value: "Already-Migrated" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalled()
    })
    const patchArg = mockUpdateAdapterInstance.mock.calls[0][1]
    expect(patchArg).not.toHaveProperty("credentialsRef")
  })
})

describe("TelegramConfigDialog — closed state", () => {
  it("does not render content when closed", () => {
    render(<TelegramConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText(/add telegram bot/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — responsive dialog layout
// ---------------------------------------------------------------------------

describe("TelegramConfigDialog — layout", () => {
  it("caps height and scrolls the body so the sticky footer stays reachable", () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("max-h-[90vh]")
    expect(dialog.className).toContain("flex-col")
    expect(dialog.querySelector('[class*="overflow-y-auto"]')).not.toBeNull()
  })
})

/**
 * The webhook secret is load-bearing, not decorative: `verify_telegram` in
 * `axum_app.rs` answers 401 to every delivery that arrives without one, and
 * the adapter refuses to call `setWebhook` at all when none is stored. Saying
 * so at save time beats letting the operator discover it from a degraded
 * health row hours later.
 */
describe("TelegramConfigDialog — webhook secret requirement", () => {
  it("blocks a webhook create with no secret", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "123:VALIDTOKEN" } })
    fireEvent.click(screen.getByRole("combobox", { name: /transport/i }))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /webhook/i }))
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/webhook secret/i))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("blocks a webhook save when nothing is stored in the keyring either", async () => {
    mockConnectorsKeyringGet.mockResolvedValue(null)
    const webhookRow: AdapterInstanceRow = {
      id: "cai_webhook",
      type: "telegram",
      displayName: "Hook Bot",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["botToken", "secretToken", "webhookSecret"],
      },
      trigger: defaultPrivateChatPolicy(),
      defaultMode: "auto",
      createdAt: 1,
      updatedAt: 1,
    } as AdapterInstanceRow

    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    // Save stays disabled until the credential read lands — until then the
    // form cannot tell an absent secret from one it has not read yet.
    fireEvent.change(screen.getByDisplayValue("Hook Bot"), { target: { value: "Renamed" } })
    await waitFor(() => expect(screen.getByRole("button", { name: /save/i })).toBeEnabled())
    await clickSave()

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/webhook secret/i))
    })
    expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
  })

  it("leaves long-poll saves alone", async () => {
    render(<TelegramConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "123:VALIDTOKEN" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalled()
    })
    expect(mockConnectorsKeyringGet).not.toHaveBeenCalled()
  })
})
