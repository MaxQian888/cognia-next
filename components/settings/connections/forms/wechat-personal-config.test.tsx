/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import type React from "react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequestLoginQr = jest.fn()
const mockPollLoginStatus = jest.fn()
const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/connectors/adapters/wechat-personal/auth", () => ({
  requestLoginQr: (...a: unknown[]) => mockRequestLoginQr(...a),
  pollLoginStatus: (...a: unknown[]) => mockPollLoginStatus(...a),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    unoptimized: _unoptimized,
    priority: _priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    unoptimized?: boolean
    priority?: boolean
  }) => <img {...props} alt={props.alt ?? ""} />,
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
  connectorsKeyringGet: (...a: unknown[]) => mockKeyringGet(...a),
  connectorsKeyringDelete: (...a: unknown[]) => mockKeyringDelete(...a),
  connectorsKeyringList: (...a: unknown[]) => mockKeyringList(...a),
}))

jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...a: unknown[]) => mockCapability(...a),
}))

const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
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
  mockIsTauri.mockReturnValue(true)
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

  it("reports QR responses that do not include a QR code", async () => {
    mockRequestLoginQr.mockResolvedValue({ qrcode_img_content: "BASE64PNG" })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
    })

    expect(screen.queryByTestId("wechat-personal-qr")).not.toBeInTheDocument()
    expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Failed"))
  })

  it("reports QR request errors", async () => {
    mockRequestLoginQr.mockRejectedValueOnce(new Error("gateway offline"))
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
    })

    expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
    expect(mockToastError).toHaveBeenCalledWith("gateway offline")
  })

  it("disables QR login outside the desktop runtime", async () => {
    mockIsTauri.mockReturnValue(false)
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

    expect(screen.getByText(/desktop runtime/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /get login qr/i })).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
    })
    expect(mockRequestLoginQr).not.toHaveBeenCalled()
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

  it("shows scanned and expired polling states without persisting credentials", async () => {
    jest.useFakeTimers()
    try {
      mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "B64" })
      mockPollLoginStatus
        .mockResolvedValueOnce({ status: "scaned" })
        .mockResolvedValueOnce({ status: "expired" })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
      })
      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/scanned/i)

      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/expired/i)
      expect(mockKeyringSet).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("reports persistence errors when the confirmed scan cannot be stored", async () => {
    jest.useFakeTimers()
    try {
      mockCreateAdapterInstance.mockRejectedValueOnce(new Error("db locked"))
      mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "B64" })
      mockPollLoginStatus.mockResolvedValue({
        status: "confirmed",
        bot_token: "tok-9",
      })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
      })
      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("db locked")
      })
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
    } finally {
      jest.useRealTimers()
    }
  })

  it("surfaces an error when the scan is confirmed but the gateway returns no bot token", async () => {
    jest.useFakeTimers()
    try {
      mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "B64" })
      mockPollLoginStatus.mockResolvedValue({ status: "confirmed" }) // no bot_token
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
      })
      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      // No silent "confirmed": the status flips to error and nothing persists.
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/no bot token/i))
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
      expect(mockKeyringSet).not.toHaveBeenCalled()
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
    settings: { baseUrl: "https://srv", accountId: "acc-old", proxyTag: "keep-me" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
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

  it("persists re-login credentials for an existing adapter", async () => {
    jest.useFakeTimers()
    try {
      mockRequestLoginQr.mockResolvedValue({ qrcode: "qr1", qrcode_img_content: "B64" })
      mockPollLoginStatus.mockResolvedValue({
        status: "confirmed",
        bot_token: "new-token",
        baseurl: "https://new",
        account_id: "acc2",
      })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={row} />)

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /re-scan qr/i }))
      })
      await act(async () => {
        jest.advanceTimersByTime(3000)
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "wx1",
        expect.objectContaining({
          // Merged with the existing row's settings — unrelated keys survive
          // the whole-object replace that updateAdapterInstance performs.
          settings: { baseUrl: "https://new", accountId: "acc2", proxyTag: "keep-me" },
        })
      )
      expect(mockKeyringSet).toHaveBeenCalledWith("wx1", "botToken", "new-token")
      expect(mockEmitCredentialsRotated).toHaveBeenCalledWith("wx1")
    } finally {
      jest.useRealTimers()
    }
  })

  it("reports edit save failures without closing the dialog", async () => {
    const onOpenChange = jest.fn()
    mockUpdateAdapterInstance.mockRejectedValueOnce(new Error("save denied"))
    render(<WeChatPersonalConfigDialog open onOpenChange={onOpenChange} row={row} />)
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
    })

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("save denied")
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("WeChatPersonalConfigDialog — sign-in state", () => {
  const existingRow = {
    id: "wxp-1",
    type: "wechat-personal",
    displayName: "Existing",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: {},
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 2,
  } as unknown as AdapterInstanceRow

  beforeEach(() => {
    mockCapability.mockReturnValue(true)
    mockKeyringList.mockResolvedValue([])
  })

  it("reports signed in when a bot token is actually stored", async () => {
    mockKeyringList.mockResolvedValue(["botToken"])
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={existingRow} />)
    await waitFor(() => expect(screen.getByText(/currently logged in/i)).toBeInTheDocument())
    expect(mockKeyringList).toHaveBeenCalledWith("wxp-1", ["botToken"])
  })

  // The row existing is not the same as a session existing: a revoked or
  // purged token used to keep reading as "logged in" forever.
  it("reports signed out when the row exists but its token does not", async () => {
    mockKeyringList.mockResolvedValue([])
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={existingRow} />)
    await waitFor(() => expect(screen.queryByText(/currently logged in/i)).not.toBeInTheDocument())
  })

  it("falls back to the old assumption when the host cannot probe", async () => {
    mockCapability.mockReturnValue(false)
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/currently logged in/i)).toBeInTheDocument()
    expect(mockKeyringList).not.toHaveBeenCalled()
  })
})
