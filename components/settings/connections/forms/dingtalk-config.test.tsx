/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

const mockCreate = jest.fn().mockResolvedValue({ id: "dt-new" })
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsHttpRequest = jest.fn()
const mockRotated = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreate(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
  connectorsHttpRequest: (...a: unknown[]) => mockConnectorsHttpRequest(...a),
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

beforeEach(() => {
  jest.clearAllMocks()
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

  it("creates a longpoll adapter and stores both credentials", async () => {
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "dingabc" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dingtalk", transportMode: "longpoll" })
      )
    })
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-new", "appKey", "dingabc")
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-new", "appSecret", "secret")
  })

  it("on edit, updates the row and emits a credential rotation", async () => {
    const row = {
      id: "dt-1",
      type: "dingtalk",
      displayName: "Existing",
      enabled: true,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["appKey", "appSecret"] },
      trigger: {},
      defaultMode: "auto",
      createdAt: 1,
      updatedAt: 2,
    } as unknown as AdapterInstanceRow
    render(<DingTalkConfigDialog open onOpenChange={jest.fn()} row={row} />)
    fireEvent.change(screen.getByLabelText(/app key/i), { target: { value: "rotated" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("dt-1", expect.any(Object)))
    expect(mockKeyringSet).toHaveBeenCalledWith("dt-1", "appKey", "rotated")
    expect(mockRotated).toHaveBeenCalledWith("dt-1")
  })
})
