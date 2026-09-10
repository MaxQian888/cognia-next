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
const mockResolveRedirect = jest.fn((host: string) => `https://${host}`)
const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/connectors/adapters/wechat-personal/auth", () => ({
  requestLoginQr: (...a: unknown[]) => mockRequestLoginQr(...a),
  pollLoginStatus: (...a: unknown[]) => mockPollLoginStatus(...a),
  resolveIlinkQrRedirect: (host: string) => mockResolveRedirect(host),
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
  useHostProfile: () => (mockIsTauri() ? "desktop" : "web-standalone"),
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
  it("renders the create title, iLink session note, and a Get-QR button", () => {
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add personal wechat/i)).toBeInTheDocument()
    expect(screen.getByText(/sign in through tencent ilink/i)).toBeInTheDocument()
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
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Failed"))
  })

  // QR login paints a login window from the desktop process, so a reachable
  // runtime elsewhere is not enough — the notice says that specifically rather
  // than the generic "your bot runs on the paired host".
  it("disables QR login outside the desktop runtime", async () => {
    mockIsTauri.mockReturnValue(false)
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)

    expect(screen.getByTestId("connector-host-notice")).toHaveAttribute("data-cause", "no-runtime")
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

describe("official WeChat QR login states", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockRequestLoginQr.mockReset().mockResolvedValue({
      qrcode: "official",
      qrcode_img_content: "https://weixin.qq.com/qr/payload",
    })
    mockPollLoginStatus.mockReset().mockResolvedValue({ status: "wait" })
    mockResolveRedirect.mockReset().mockImplementation((host) => `https://${host}`)
  })
  afterEach(() => {
    jest.useRealTimers()
  })
  async function getQr() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get login qr/i }))
    })
  }
  async function advance(ms = 2500) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }
  it("encodes the official URL payload as an SVG QR instead of an image URL", async () => {
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    const qr = screen.getByTestId("wechat-personal-qr")
    expect(qr.tagName.toLowerCase()).toBe("svg")
    expect(qr).toHaveAttribute("aria-label", "WeChat login QR code")
    expect(qr).not.toHaveAttribute("src")
  })
  it("retains legacy image data URI without prepending another base64 prefix", async () => {
    mockRequestLoginQr.mockResolvedValue({
      qrcode: "legacy",
      qrcode_img_content: "data:image/png;base64,AQID",
    })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    expect(screen.getByTestId("wechat-personal-qr")).toHaveAttribute(
      "src",
      "data:image/png;base64,AQID"
    )
  })
  it("never overlaps long-polls", async () => {
    let resolvePoll!: (value: unknown) => void
    mockPollLoginStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve
        })
    )
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    await advance(30_000)
    expect(mockPollLoginStatus).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolvePoll({ status: "wait" })
    })
    await advance()
    expect(mockPollLoginStatus).toHaveBeenCalledTimes(2)
  })
  it("accepts a pairing code, prompts again after mismatch, and confirms after retry", async () => {
    mockPollLoginStatus
      .mockResolvedValueOnce({ status: "need_verifycode" })
      .mockResolvedValueOnce({ status: "need_verifycode" })
      .mockResolvedValueOnce({ status: "scaned" })
      .mockResolvedValueOnce({
        status: "confirmed",
        bot_token: "paired-token",
        account_id: "bot-official",
      })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    await advance()
    const input = screen.getByLabelText(/pairing code/i)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /verify code/i }))
    })
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("numeric"))
    fireEvent.change(input, { target: { value: "1234" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /verify code/i }))
    })
    await advance(1)
    expect(mockPollLoginStatus).toHaveBeenLastCalledWith(
      "official",
      undefined,
      "https://ilinkai.weixin.qq.com",
      "1234"
    )
    expect(screen.getByText(/code did not match/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/pairing code/i), { target: { value: "5678" } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(/pairing code/i), { key: "Enter" })
    })
    await advance(1)
    await advance()
    expect(mockKeyringSet).toHaveBeenCalledWith("wx-new", "botToken", "paired-token")
    expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ accountId: "bot-official" }) })
    )
  })
  it.each(["verify_code_blocked", "binded_redirect"])(
    "stops on %s without fabricating credentials",
    async (status) => {
      mockPollLoginStatus.mockResolvedValue({ status })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
      await getQr()
      await advance()
      await advance(20_000)
      expect(mockPollLoginStatus).toHaveBeenCalledTimes(1)
      expect(mockKeyringSet).not.toHaveBeenCalled()
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(
        status === "verify_code_blocked" ? /incorrect codes/i : /already connected/i
      )
      await getQr()
      expect(mockRequestLoginQr).toHaveBeenCalledTimes(2)
    }
  )
  it("switches polling hosts after a validated IDC redirect", async () => {
    mockPollLoginStatus
      .mockResolvedValueOnce({
        status: "scaned_but_redirect",
        redirect_host: "ilink2.weixin.qq.com",
      })
      .mockResolvedValue({ status: "wait" })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    await advance()
    await advance()
    expect(mockResolveRedirect).toHaveBeenCalledWith("ilink2.weixin.qq.com")
    expect(mockPollLoginStatus).toHaveBeenLastCalledWith(
      "official",
      undefined,
      "https://ilink2.weixin.qq.com",
      undefined
    )
  })
  it.each([undefined, "unsafe.local"])(
    "stops when a redirect host is missing or rejected: %s",
    async (host) => {
      mockPollLoginStatus.mockResolvedValue({ status: "scaned_but_redirect", redirect_host: host })
      mockResolveRedirect.mockImplementation(() => {
        throw new Error("invalid redirect")
      })
      render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
      await getQr()
      await advance()
      await advance(10_000)
      expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
      expect(mockPollLoginStatus).toHaveBeenCalledTimes(1)
      expect(mockKeyringSet).not.toHaveBeenCalled()
    }
  )
  it("surfaces an unknown login state in localized guidance", async () => {
    mockPollLoginStatus.mockResolvedValue({ status: "future_unknown" })
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    await advance()
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("unsupported status"))
    expect(mockKeyringSet).not.toHaveBeenCalled()
  })
  it("surfaces polling errors and stops instead of rejecting an unhandled promise", async () => {
    mockPollLoginStatus.mockRejectedValue(new Error("status unavailable"))
    render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await getQr()
    await advance()
    await advance(10_000)
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Could not check"))
    expect(mockPollLoginStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("wechat-personal-login-status")).toHaveTextContent(/failed/i)
  })
  it("ignores an in-flight confirmation after close and clears the QR before reopening", async () => {
    let resolvePoll!: (value: unknown) => void
    mockPollLoginStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve
        })
    )
    const { rerender } = render(
      <WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />
    )
    await getQr()
    await advance()
    rerender(<WeChatPersonalConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    await act(async () => {
      resolvePoll({ status: "confirmed", bot_token: "stale" })
    })
    rerender(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    await advance(10_000)
    expect(mockKeyringSet).not.toHaveBeenCalled()
    expect(screen.queryByTestId("wechat-personal-qr")).not.toBeInTheDocument()
    expect(mockPollLoginStatus).toHaveBeenCalledTimes(1)
  })
  it("ignores a QR request that completes after the dialog closes", async () => {
    let resolveQr!: (value: unknown) => void
    mockRequestLoginQr.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQr = resolve
        })
    )
    const { rerender } = render(
      <WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />
    )
    await getQr()
    rerender(<WeChatPersonalConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    await act(async () => {
      resolveQr({ qrcode: "stale", qrcode_img_content: "https://weixin.qq.com/stale" })
    })
    rerender(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByTestId("wechat-personal-qr")).not.toBeInTheDocument()
    await advance(10_000)
    expect(mockPollLoginStatus).not.toHaveBeenCalled()
  })
})

it("validates the display name and lets the user cancel without writing", async () => {
  const onOpenChange = jest.fn()
  render(<WeChatPersonalConfigDialog open onOpenChange={onOpenChange} row={null} />)
  fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "  " } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
  })
  expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("name"))
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
})
it("refuses to save incomplete quiet hours", async () => {
  const row = {
    id: "quiet",
    type: "wechat-personal",
    displayName: "Bot",
    settings: {},
    quietHours: { from: "", to: "18:00", tz: "UTC" },
  } as AdapterInstanceRow
  render(<WeChatPersonalConfigDialog open onOpenChange={jest.fn()} row={row} />)
  fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Updated" } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
  })
  expect(mockToastError).toHaveBeenCalled()
  expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
})
