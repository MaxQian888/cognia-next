/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "mx-new-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockEmitCredentialsRotated = jest.fn()
const mockLogin = jest.fn()

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
jest.mock("@/lib/connectors/adapters/matrix/auth", () => ({
  matrixLoginWithPassword: (...args: unknown[]) => mockLogin(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

import { MatrixConfigDialog } from "./matrix-config"

beforeEach(() => jest.clearAllMocks())

describe("MatrixConfigDialog — create new", () => {
  it("renders the create title and homeserver + access token inputs", () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add matrix connector/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/homeserver/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument()
  })

  it("blocks save when the homeserver is missing", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Homeserver"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("blocks save when the access token is missing", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("access token"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("creates the adapter and stores the access token in the keyring", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "https://matrix.org" },
    })
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "syt_secret" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "matrix",
          transportMode: "longpoll",
          settings: expect.objectContaining({ homeserver: "https://matrix.org" }),
        })
      )
    })
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("mx-new-id", "accessToken", "syt_secret")
    expect(mockToastSuccess).toHaveBeenCalled()
  })

  it("password login fills the token and reports the signed-in user", async () => {
    mockLogin.mockResolvedValue({ accessToken: "syt_from_login", userId: "@bot:matrix.org" })
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bot" } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("matrix-password-login"))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("matrix.org", "bot", "pw")
    })
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("@bot:matrix.org"))
  })
})

describe("MatrixConfigDialog — edit existing", () => {
  const row = {
    id: "mx-1",
    type: "matrix" as const,
    displayName: "My Matrix",
    enabled: true,
    transportMode: "longpoll" as const,
    settings: { homeserver: "https://matrix.org" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["accessToken"] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto" as const,
    createdAt: 1,
    updatedAt: 1,
  }

  it("renders the edit title and updates without re-entering the token", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={row} />)
    expect(screen.getByText(/edit matrix connector/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "mx-1",
        expect.objectContaining({ displayName: "Renamed" })
      )
    })
    // Token left blank → keyring untouched.
    expect(mockConnectorsKeyringSet).not.toHaveBeenCalled()
    expect(mockEmitCredentialsRotated).toHaveBeenCalledWith("mx-1")
  })
})
