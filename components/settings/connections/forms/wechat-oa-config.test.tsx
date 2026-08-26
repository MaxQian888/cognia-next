/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"
import type { TunnelStatus } from "@/hooks/use-tunnel-status"

const mockCreate = jest.fn().mockResolvedValue({ id: "wxoa-new" })
const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsHttpRequest = jest.fn()
const mockRotated = jest.fn()
const mockUseTunnelStatus = jest.fn((): TunnelStatus => ({
  url: "https://demo.trycloudflare.com",
  running: true,
  loading: false,
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreate(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
  connectorsHttpRequest: (...a: unknown[]) => mockConnectorsHttpRequest(...a),
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
  emitCredentialsRotated: (...a: unknown[]) => mockRotated(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))
jest.mock("@/hooks/use-tunnel-status", () => ({
  useTunnelStatus: () => mockUseTunnelStatus(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { clearWechatOaTokenCache } from "@/lib/connectors/adapters/wechat-oa/auth"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock
import { WechatOaConfigDialog } from "./wechat-oa-config"

const AES_KEY = "A".repeat(43)
const SAVED_ROW = {
  id: "wxoa-existing",
  type: "wechat-oa",
  displayName: "Existing OA",
  enabled: true,
  transportMode: "webhook",
  settings: {},
  credentialsRef: {
    keyringService: "com.cognia.platforms",
    accounts: ["appId", "appSecret", "token", "encodingAesKey"],
  },
  trigger: {},
  defaultMode: "auto",
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 2,
} as unknown as AdapterInstanceRow

function httpResp(status: number, body: unknown): TauriHttpResponse {
  return {
    status,
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  }
}

beforeEach(() => {
  mockCapability.mockReturnValue(true)
  mockKeyringGet.mockResolvedValue(null)
  mockKeyringList.mockResolvedValue([])
  jest.clearAllMocks()
  mockUseTunnelStatus.mockReturnValue({
    url: "https://demo.trycloudflare.com",
    running: true,
    loading: false,
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
  clearWechatOaTokenCache("wx1", "sec")
  clearWechatOaTokenCache("bad", "sec")
})

describe("WechatOaConfigDialog", () => {
  it("renders the create title and the four credential inputs + webhook URL", () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add wechat official account/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app secret/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/encodingaeskey/i)).toBeInTheDocument()
  })

  it("renders the app credential test button", () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test credentials/i })).toBeInTheDocument()
  })

  it("renders the tunnel-backed public webhook URL for a saved adapter", () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={SAVED_ROW} />)

    expect(screen.getByTestId("wechat-oa-webhook-url-input")).toHaveValue(
      "https://demo.trycloudflare.com/webhook/wechat-oa/wxoa-existing"
    )
  })

  it("does not render a pseudo webhook path before the adapter has been saved", () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)

    expect(screen.getByTestId("wechat-oa-webhook-url-input")).toHaveValue("(generated after save)")
    expect(screen.getByTestId("wechat-oa-webhook-url-input")).not.toHaveValue(
      expect.stringContaining("/webhook/wechat-oa/")
    )
    expect(screen.queryByTestId("wechat-oa-webhook-url-copy")).not.toBeInTheDocument()
  })

  it("copies the public webhook URL for a saved adapter", async () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={SAVED_ROW} />)

    fireEvent.click(screen.getByTestId("wechat-oa-webhook-url-copy"))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "https://demo.trycloudflare.com/webhook/wechat-oa/wxoa-existing"
      )
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("copied"))
    })
  })

  it("falls back to the relative webhook path when the public tunnel is not running", () => {
    mockUseTunnelStatus.mockReturnValueOnce({
      url: null,
      running: false,
      loading: false,
    })

    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={SAVED_ROW} />)

    expect(screen.getByTestId("wechat-oa-webhook-url-input")).toHaveValue(
      "/webhook/wechat-oa/wxoa-existing"
    )
    expect(screen.getByTestId("wechat-oa-webhook-url-tunnel-off")).toBeInTheDocument()
  })

  it("disables the copy button while the tunnel is down so the relative path can't be copied", () => {
    // Tunnel down (running:false) → webhookUrlIsPublic is false regardless of url.
    mockUseTunnelStatus.mockReturnValueOnce({
      url: "https://demo.trycloudflare.com",
      running: false,
      loading: false,
    })
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={SAVED_ROW} />)
    expect(screen.getByTestId("wechat-oa-webhook-url-copy")).toBeDisabled()
  })

  it("shows a success status after minting an access token", async () => {
    mockConnectorsHttpRequest.mockResolvedValueOnce(
      httpResp(200, { access_token: "wx-access-token", expires_in: 7200 })
    )

    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "wx1" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "sec" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledTimes(1)
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("Access token minted"))
    })
    expect(screen.getByRole("status")).toHaveTextContent("Access token minted")
    expect(screen.getByRole("status")).not.toHaveTextContent("wx-access-token")
  })

  it("shows an error status when WeChat rejects the app credentials", async () => {
    mockConnectorsHttpRequest.mockResolvedValueOnce(
      httpResp(200, { errcode: 40013, errmsg: "invalid appid" })
    )

    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "bad" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "sec" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("invalid appid"))
      expect(screen.getByRole("status")).toHaveTextContent("invalid appid")
    })
  })

  it("blocks save without credentials", async () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("validates the EncodingAESKey length", async () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "wx1" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "sec" } })
    fireEvent.change(screen.getByLabelText(/^token/i), { target: { value: "tok" } })
    fireEvent.change(screen.getByLabelText(/encodingaeskey/i), { target: { value: "tooshort" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("43")))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("creates a webhook adapter and stores all four credentials", async () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "wx1" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "sec" } })
    fireEvent.change(screen.getByLabelText(/^token/i), { target: { value: "tok" } })
    fireEvent.change(screen.getByLabelText(/encodingaeskey/i), { target: { value: AES_KEY } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "wechat-oa", transportMode: "webhook" })
      )
    })
    expect(mockKeyringSet).toHaveBeenCalledWith("wxoa-new", "appId", "wx1")
    expect(mockKeyringSet).toHaveBeenCalledWith("wxoa-new", "encodingAesKey", AES_KEY)
  })
})

describe("WechatOaConfigDialog — credential prefill", () => {
  const prefillRow = {
    id: "wxoa-1",
    type: "wechat-oa",
    displayName: "Existing",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["appId", "appSecret", "token", "encodingAesKey"],
    },
    trigger: {},
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 2,
  } as unknown as AdapterInstanceRow

  function openExisting() {
    return render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={prefillRow} />)
  }

  function storedCredentials() {
    mockKeyringGet.mockImplementation(async (_id: string, name: string) => {
      if (name === "appId") return "wxabc"
      if (name === "appSecret") return "s3cret"
      if (name === "token") return "tok"
      if (name === "encodingAesKey") return "aes"
      return null
    })
  }

  it("reads the stored credentials back into the fields", async () => {
    storedCredentials()
    openExisting()

    const identifier = screen.getByLabelText(/app ?id/i) as HTMLInputElement
    await waitFor(() => expect(identifier.value).toBe("wxabc"))
    // Identifiers stay readable; only the secret is masked.
    expect(identifier.type).toBe("text")

    const secret = screen.getByLabelText(/app secret/i) as HTMLInputElement
    await waitFor(() => expect(secret.value).toBe("s3cret"))
    expect(secret.type).toBe("password")
  })

  // Prefilling puts real values in previously-empty boxes; the form must not
  // read that as the operator having typed them.
  it("does not look edited just because the values were read back", async () => {
    storedCredentials()
    openExisting()
    await waitFor(() =>
      expect((screen.getByLabelText(/app secret/i) as HTMLInputElement).value).toBe("s3cret")
    )
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
  })

  // The webhook signature token authenticates every inbound callback, so it
  // is a secret; it used to render in a plain-text box.
  it("masks the webhook signature token", async () => {
    storedCredentials()
    openExisting()
    const token = screen.getByLabelText(/^token$/i) as HTMLInputElement
    await waitFor(() => expect(token.value).toBe("tok"))
    expect(token.type).toBe("password")
  })

  it("says the value is saved-but-unreadable when the host refuses the read", async () => {
    mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
    openExisting()

    await waitFor(() =>
      expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
    )
    expect((screen.getByLabelText(/app secret/i) as HTMLInputElement).value).toBe("")
    // A blank box nobody could read must never be taken for a deletion.
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })
})
