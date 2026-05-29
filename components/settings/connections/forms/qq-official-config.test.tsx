/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockCreate = jest.fn().mockResolvedValue({ id: "qq-new" })
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
import { QQOfficialConfigDialog } from "./qq-official-config"

beforeEach(() => jest.clearAllMocks())

describe("QQOfficialConfigDialog", () => {
  it("renders the create title and credential inputs", () => {
    render(<QQOfficialConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add qq official bot/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/app id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument()
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
})
