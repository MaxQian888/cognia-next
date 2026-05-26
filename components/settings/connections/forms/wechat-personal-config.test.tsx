/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequestLoginQr = jest.fn()
const mockPollLoginStatus = jest.fn()
jest.mock("@/lib/connectors/adapters/wechat-personal/auth", () => ({
  requestLoginQr: (...a: unknown[]) => mockRequestLoginQr(...a),
  pollLoginStatus: (...a: unknown[]) => mockPollLoginStatus(...a),
}))

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "wx-new" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreateAdapterInstance(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdateAdapterInstance(...a),
}))

const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
}))

const mockEmitCredentialsRotated = jest.fn()
jest.mock("@/lib/connectors/credentials-events", () => ({
  emitCredentialsRotated: (...a: unknown[]) => mockEmitCredentialsRotated(...a),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
import { toast } from "sonner"
const mockToastError = toast.error as jest.Mock
const mockToastSuccess = toast.success as jest.Mock

import { WeChatPersonalConfigDialog } from "./wechat-personal-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateAdapterInstance.mockResolvedValue({ id: "wx-new" })
})

describe("WeChatPersonalConfigDialog — create", () => {
  it("renders the create title, ban-risk note, and a Get-QR button", () => {
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add personal wechat/i)).toBeInTheDocument()
    expect(screen.getByText(/account-ban risk/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /get login qr/i })).toBeInTheDocument()
  })

  it("requests a QR code and shows it with a waiting status", async () => {
    mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "BASE64PNG" })
    mockPollLoginStatus.mockResolvedValue({ status: "wait" })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
    })

    expect(mockRequestLoginQr).toHaveBeenCalled()
    expect(screen.getByTestId("wechat-personal-qr")).toBeInTheDocument()
    expect(screen.getByText(/waiting for scan/i)).toBeInTheDocument()
  })

  it("persists token + creates the adapter when the scan is confirmed", async () => {
    jest.useFakeTimers()
    try {
      mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "B64" })
      mockPollLoginStatus.mockResolvedValue({
        status: "confirmed",
        bot_token: "tok-9",
        baseurl: "https://srv",
        account_id: "acc1",
      })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
      })
      // Fire the polling interval, then flush the poll + persist microtasks.
      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "wechat-personal",
          transportMode: "longpoll",
          settings: expect.objectContaining({ baseUrl: "https://srv", accountId: "acc1" }),
        })
      )
      expect(mockKeyringSet).toHaveBeenCalledWith("wx-new", "botToken", "tok-9")
    } finally {
      jest.useRealTimers()
    }
  })

  it("blocks save before a confirmed login", async () => {
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create/i }))
    })
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })
})

describe("WeChatPersonalConfigDialog — edit", () => {
  const row: AdapterInstanceRow = {
    id: "wx1",
    type: "wechat-personal",
    displayName: "Existing WeChat",
    enabled: true,
    transportMode: "longpoll",
    settings: { baseUrl: "https://srv" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 1,
    updatedAt: 1,
  }

  it("renders the edit title and saves display-name changes", async () => {
    const onOpenChange = jest.fn()
    render(<WeChatPersonalConfigDialog open onOpenChange={onOpenChange} row={row} />)
    expect(screen.getByText(/configure personal wechat/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
    })
    await waitFor(() =>
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "wx1",
        expect.objectContaining({ displayName: "Renamed" })
      )
    )
    expect(mockToastSuccess).not.toHaveBeenCalled() // edit save just closes
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
