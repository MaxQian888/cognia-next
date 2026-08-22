/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockCreate = jest.fn().mockResolvedValue({ id: "qq-new" })
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
import { clearQQTokenCache } from "@/lib/connectors/adapters/qq-official/auth"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock
import { QQOfficialConfigDialog } from "./qq-official-config"

function httpResp(status: number, body: unknown): TauriHttpResponse {
  return {
    status,
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  clearQQTokenCache("102000", "secret")
  clearQQTokenCache("bad", "secret")
})

describe("QQOfficialConfigDialog", () => {
  it("renders the create title and credential inputs", () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add qq official bot/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument()
  })

  it("renders the credential test button", () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test credentials/i })).toBeInTheDocument()
  })

  it("shows a success status after minting an access token and resolving the gateway", async () => {
    mockConnectorsHttpRequest
      .mockResolvedValueOnce(httpResp(200, { access_token: "qq-token", expires_in: 7200 }))
      .mockResolvedValueOnce(httpResp(200, { url: "wss://api.sgroup.qq.com/websocket" }))

    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "102000" } })
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledTimes(2)
      expect(mockToastSuccess).toHaveBeenCalledWith(
        expect.stringContaining("wss://api.sgroup.qq.com/websocket")
      )
    })
    expect(screen.getByRole("status")).toHaveTextContent("wss://api.sgroup.qq.com/websocket")
  })

  it("shows an error status when QQ rejects the credentials", async () => {
    mockConnectorsHttpRequest.mockResolvedValueOnce(httpResp(200, { message: "bad secret" }))

    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "bad" } })
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test credentials/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("bad secret"))
      expect(screen.getByRole("status")).toHaveTextContent("bad secret")
    })
  })

  it("blocks save without credentials", async () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("creates a gateway adapter and stores both credentials", async () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "102000" } })
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "qq-official", transportMode: "gateway" })
      )
    })
    expect(mockKeyringSet).toHaveBeenCalledWith("qq-new", "appId", "102000")
    expect(mockKeyringSet).toHaveBeenCalledWith("qq-new", "clientSecret", "secret")
  })

  it("creates a webhook adapter through the shared transport field", async () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "102000" } })
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "secret" } })
    fireEvent.click(screen.getByLabelText(/https webhook/i))
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "qq-official", transportMode: "webhook" })
      )
    )
  })

  it("persists transport changes and enters the existing runtime rebuild path", async () => {
    const row = {
      id: "qq-existing",
      type: "qq-official",
      displayName: "QQ Existing",
      enabled: true,
      transportMode: "gateway",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 2,
    } as AdapterInstanceRow
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={row} />)

    fireEvent.click(screen.getByLabelText(/https webhook/i))
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        "qq-existing",
        expect.objectContaining({ transportMode: "webhook" })
      )
    )
    expect(mockRotated).toHaveBeenCalledWith("qq-existing")
  })
})
