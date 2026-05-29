/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockCreate = jest.fn().mockResolvedValue({ id: "wxoa-new" })
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockRotated = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreate(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...a: unknown[]) => mockKeyringSet(...a),
}))
jest.mock("@/lib/connectors/credentials-events", () => ({
  emitCredentialsRotated: (...a: unknown[]) => mockRotated(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastError = toast.error as jest.Mock
import { WechatOaConfigDialog } from "./wechat-oa-config"

const AES_KEY = "A".repeat(43)

beforeEach(() => jest.clearAllMocks())

describe("WechatOaConfigDialog", () => {
  it("renders the create title and the four credential inputs + webhook URL", () => {
    render(<WechatOaConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add wechat official account/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app secret/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^token/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/encodingaeskey/i)).toBeInTheDocument()
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
