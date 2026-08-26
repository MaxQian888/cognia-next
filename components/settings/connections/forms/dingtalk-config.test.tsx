/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

const mockCreate = jest.fn().mockResolvedValue({ id: "dt-new" })
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
const mockConnectorsHttpRequest = jest.fn()
const mockRotated = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreate(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
  connectorsKeyringGet: (...a: unknown[]) => mockKeyringGet(...a),
  connectorsKeyringDelete: (...a: unknown[]) => mockKeyringDelete(...a),
  connectorsKeyringList: (...a: unknown[]) => mockKeyringList(...a),
  connectorsHttpRequest: (...a: unknown[]) => mockConnectorsHttpRequest(...a),
}))
const hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...a: unknown[]) => mockCapability(...a),
  useHostProfile: () => hostProfile,
}))
jest.mock("@/lib/connectors/credentials-events", () => ({
  emitCredentialsRotated: (...a: unknown[]) => mockRotated(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { clearDingTalkTokenCache } from "@/lib/connectors/adapters/dingtalk/auth"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock
import { DingTalkConfigDialog } from "./dingtalk-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function httpResp(status: number, body: unknown): TauriHttpResponse {
  return {
    status,
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  }
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
  jest.clearAllMocks()
  mockCapability.mockReturnValue(true)
  mockKeyringGet.mockResolvedValue(null)
  mockKeyringList.mockResolvedValue([])
  clearDingTalkTokenCache("dingabc", "secret")
  clearDingTalkTokenCache("bad", "secret")
})

describe("DingTalkConfigDialog", () => {
  it("renders the create title and credential inputs", () => {
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add dingtalk connector/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app key/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app secret/i)).toBeInTheDocument()
  })

  it("renders the credential test button", () => {
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test credentials/i })).toBeInTheDocument()
  })

  it("shows a success status after minting an app access token", async () => {
    mockConnectorsHttpRequest.mockResolvedValueOnce(
      httpResp(200, { accessToken: "dt-access-token", expireIn: 7200 })
    )

    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "dingabc" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledTimes(1)
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("Access token minted"))
    })
    expect(screen.getByRole("status")).toHaveTextContent("Access token minted")
    expect(screen.getByRole("status")).not.toHaveTextContent("dt-access-token")
  })

  it("shows an error status when DingTalk rejects the credentials", async () => {
    mockConnectorsHttpRequest.mockResolvedValueOnce(httpResp(200, { message: "invalid app" }))

    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "bad" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("invalid app"))
      expect(screen.getByRole("status")).toHaveTextContent("invalid app")
    })
  })

  it("blocks save without credentials", async () => {
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("creates a gateway (Stream mode) adapter and stores both credentials", async () => {
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "dingabc" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dingtalk", transportMode: "gateway" })
      )
    })
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-new", "appKey", "dingabc")
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-new", "appSecret", "secret")
  })

  it("on edit, tolerates a legacy longpoll row (updates without touching transportMode)", async () => {
    const row = {
      id: "dt-1",
      type: "dingtalk",
      displayName: "Existing",
      enabled: true,
      // legacy rows created before the gateway rename still carry "longpoll"
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appKey", "appSecret"] },
      trigger: {},
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 2,
    } as unknown as AdapterInstanceRow
    // A real existing row has both credentials stored; rotating one must not
    // read as "the other is missing".
    mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
      name === "appKey" ? "dingabc" : "s3cret"
    )
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={row} />)
    await waitFor(() =>
      expect((screen.getByLabelText(/app key/i) as HTMLInputElement).value).toBe("dingabc")
    )
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "rotated" } })
    await clickSave()
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("dt-1", expect.any(Object)))
    // the edit path never rewrites transportMode — legacy value stays put
    expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty("transportMode")
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-1", "appKey", "rotated")
    // The untouched secret is not rewritten.
    expect(mockKeyringSet).toHaveBeenCalledTimes(1)
    expect(mockRotated).toHaveBeenCalledWith("dt-1")
  })

  describe("credential prefill", () => {
    const existingRow = {
      id: "dt-1",
      type: "dingtalk",
      displayName: "Existing",
      enabled: true,
      transportMode: "gateway",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appKey", "appSecret"] },
      trigger: {},
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 2,
    } as unknown as AdapterInstanceRow

    function openExisting() {
      return render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={existingRow} />)
    }

    it("fills the stored values back into the fields, masking only the secret", async () => {
      mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
        name === "appKey" ? "dingabc" : "s3cret"
      )
      openExisting()

      const key = screen.getByLabelText(/app key/i) as HTMLInputElement
      const secret = screen.getByLabelText(/app secret/i) as HTMLInputElement
      await waitFor(() => expect(key.value).toBe("dingabc"))
      expect(secret.value).toBe("s3cret")
      // The identifier stays readable; the secret does not.
      expect(key.type).toBe("text")
      expect(secret.type).toBe("password")
    })

    // Prefilling puts real values in previously-empty boxes; the form must not
    // read that as the operator having typed them.
    it("does not look edited just because the values were read back", async () => {
      mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
        name === "appKey" ? "dingabc" : "s3cret"
      )
      openExisting()
      await waitFor(() =>
        expect((screen.getByLabelText(/app key/i) as HTMLInputElement).value).toBe("dingabc")
      )
      expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
    })

    it("saves an unrelated edit without rewriting the credentials", async () => {
      mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
        name === "appKey" ? "dingabc" : "s3cret"
      )
      openExisting()
      await waitFor(() =>
        expect((screen.getByLabelText(/app key/i) as HTMLInputElement).value).toBe("dingabc")
      )

      fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })
      await clickSave()

      await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
      expect(mockKeyringSet).not.toHaveBeenCalled()
      expect(mockKeyringDelete).not.toHaveBeenCalled()
    })

    it("refuses to save a required credential the operator emptied", async () => {
      mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
        name === "appKey" ? "dingabc" : "s3cret"
      )
      openExisting()
      await waitFor(() =>
        expect((screen.getByLabelText(/app secret/i) as HTMLInputElement).value).toBe("s3cret")
      )

      fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "" } })
      await clickSave()

      await waitFor(() => expect(mockToastError).toHaveBeenCalled())
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockKeyringDelete).not.toHaveBeenCalled()
    })

    it("says the value is saved-but-unreadable when the host refuses the read", async () => {
      mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
      openExisting()

      await waitFor(() =>
        expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
      )
      expect((screen.getByLabelText(/app secret/i) as HTMLInputElement).value).toBe("")
    })

    it("still saves the rest of the form when the credentials could not be read", async () => {
      mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
      openExisting()
      await waitFor(() =>
        expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
      )

      fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })
      await clickSave()

      await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
      // Blank boxes here mean "I could not read them", never "delete them".
      expect(mockKeyringDelete).not.toHaveBeenCalled()
      expect(mockKeyringSet).not.toHaveBeenCalled()
    })
  })
})
