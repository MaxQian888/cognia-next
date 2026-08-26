/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "wc-new-id" })
const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockEmitCredentialsRotated = jest.fn()
const mockProbeWeComCredentials = jest.fn().mockResolvedValue({ ok: true })

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsKeyringGet: (...args: unknown[]) => mockKeyringGet(...args),
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
  connectorsKeyringList: (...args: unknown[]) => mockKeyringList(...args),
}))

const hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...args: unknown[]) => mockCapability(...args),
  useHostProfile: () => hostProfile,
}))

jest.mock("@/lib/connectors/credentials-events", () => ({
  emitCredentialsRotated: (...args: unknown[]) => mockEmitCredentialsRotated(...args),
}))

jest.mock("@/lib/connectors/adapters/wecom/probe", () => ({
  probeWeComCredentials: (...args: unknown[]) => mockProbeWeComCredentials(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

import { WeComConfigDialog } from "./wecom-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

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
  mockKeyringGet.mockResolvedValue(null)
  mockKeyringList.mockResolvedValue([])
  jest.clearAllMocks()
  mockProbeWeComCredentials.mockResolvedValue({ ok: true })
})

describe("WeComConfigDialog — create new", () => {
  it("renders the create title and the BotID + Secret inputs", () => {
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add wecom/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/bot id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/secret/i)).toBeInTheDocument()
  })

  it("blocks save with an error toast when credentials are missing", async () => {
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Bot ID"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("tests the BotID and Secret against the WeCom long-connection subscribe endpoint", async () => {
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot id/i), { target: { value: "wb_abc" } })
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: "sec_123" } })
    fireEvent.click(screen.getByRole("button", { name: /test wecom credentials/i }))

    await waitFor(() => {
      expect(mockProbeWeComCredentials).toHaveBeenCalledWith("wb_abc", "sec_123")
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("Subscribe"))
    })
    expect(screen.getByRole("status")).toHaveTextContent("Subscribe")
    expect(screen.getByRole("status")).not.toHaveTextContent("sec_123")
  })

  it("shows a credential test error when WeCom rejects the subscribe frame", async () => {
    mockProbeWeComCredentials.mockResolvedValueOnce({
      ok: false,
      error: "subscribe failed: 60020 bad secret",
    })

    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot id/i), { target: { value: "wb_abc" } })
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: /test wecom credentials/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("60020"))
      expect(screen.getByRole("status")).toHaveTextContent("60020")
    })
  })

  it("creates the adapter and stores botId + secret in the keyring", async () => {
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot id/i), { target: { value: "wb_abc" } })
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: "sec_123" } })
    fireEvent.change(screen.getByLabelText(/welcome message/i), {
      target: { value: "Welcome!" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "wecom",
          transportMode: "gateway",
          settings: expect.objectContaining({ welcomeMessage: "Welcome!" }),
        })
      )
    })
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("wc-new-id", "botId", "wb_abc")
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("wc-new-id", "secret", "sec_123")
    expect(mockToastSuccess).toHaveBeenCalled()
  })

  it("keeps the old connection untouched when strict save preflight fails", async () => {
    mockProbeWeComCredentials.mockResolvedValueOnce({ ok: false, error: "bad candidate" })
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot id/i), { target: { value: "wb_bad" } })
    fireEvent.change(screen.getByLabelText(/secret/i), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("bad candidate"))
    )
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    expect(mockConnectorsKeyringSet).not.toHaveBeenCalled()
  })
})

describe("WeComConfigDialog — edit existing", () => {
  const row: AdapterInstanceRow = {
    id: "wc1",
    type: "wecom",
    displayName: "Existing Bot",
    enabled: true,
    transportMode: "gateway",
    settings: { welcomeMessage: "hi" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botId", "secret"] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 1,
  }

  it("renders the edit title and allows saving without re-entering credentials", async () => {
    // A real existing row has both credentials stored; without them the form
    // would (correctly) refuse to save a bot that cannot authenticate.
    mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
      name === "botId" ? "bot-42" : "s3cret"
    )
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={row} />)
    expect(screen.getByText(/configure wecom/i)).toBeInTheDocument()
    // Change the display name to make the form dirty, then save.
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "Renamed Bot" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "wc1",
        expect.objectContaining({ displayName: "Renamed Bot" })
      )
    })
    // No credentials re-entered → keyring untouched, but hot-reload fired.
    expect(mockConnectorsKeyringSet).not.toHaveBeenCalled()
    expect(mockEmitCredentialsRotated).toHaveBeenCalledWith("wc1")
  })
})

describe("WeComConfigDialog — credential prefill", () => {
  const prefillRow = {
    id: "wc-1",
    type: "wecom",
    displayName: "Existing",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botId", "secret"] },
    trigger: {},
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 2,
  } as unknown as AdapterInstanceRow

  function openExisting() {
    return render(<WeComConfigDialog open onOpenChange={jest.fn()} row={prefillRow} />)
  }

  function storedCredentials() {
    mockKeyringGet.mockImplementation(async (_id: string, name: string) => {
      if (name === "botId") return "bot-42"
      if (name === "secret") return "s3cret"
      return null
    })
  }

  it("reads the stored credentials back into the fields", async () => {
    storedCredentials()
    openExisting()

    const identifier = screen.getByLabelText(/bot ?id/i) as HTMLInputElement
    await waitFor(() => expect(identifier.value).toBe("bot-42"))
    // Identifiers stay readable; only the secret is masked.
    expect(identifier.type).toBe("text")

    const secret = screen.getByLabelText(/^secret$/i) as HTMLInputElement
    await waitFor(() => expect(secret.value).toBe("s3cret"))
    expect(secret.type).toBe("password")
  })

  // Prefilling puts real values in previously-empty boxes; the form must not
  // read that as the operator having typed them.
  it("does not look edited just because the values were read back", async () => {
    storedCredentials()
    openExisting()
    await waitFor(() =>
      expect((screen.getByLabelText(/^secret$/i) as HTMLInputElement).value).toBe("s3cret")
    )
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
  })

  it("says the value is saved-but-unreadable when the host refuses the read", async () => {
    mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
    openExisting()

    await waitFor(() =>
      expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
    )
    expect((screen.getByLabelText(/^secret$/i) as HTMLInputElement).value).toBe("")
    // A blank box nobody could read must never be taken for a deletion.
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })
})
