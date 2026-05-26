/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "wc-new-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockEmitCredentialsRotated = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
}))

jest.mock("@/lib/connectors/credentials-events", () => ({
  emitCredentialsRotated: (...args: unknown[]) => mockEmitCredentialsRotated(...args),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

import { WeComConfigDialog } from "./wecom-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

beforeEach(() => {
  jest.clearAllMocks()
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
    createdAt: 1,
    updatedAt: 1,
  }

  it("renders the edit title and allows saving without re-entering credentials", async () => {
    render(<WeComConfigDialog open onOpenChange={jest.fn()} row={row} />)
    expect(screen.getByText(/configure wecom/i)).toBeInTheDocument()
    // Change the display name to make the form dirty, then save.
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "Renamed Bot" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))

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
