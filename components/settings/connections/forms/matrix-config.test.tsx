/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "mx-new-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockEmitCredentialsRotated = jest.fn()
const mockLogin = jest.fn()
const mockProbeMatrixAccessToken = jest.fn()

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
  probeMatrixAccessToken: (...args: unknown[]) => mockProbeMatrixAccessToken(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

import { MatrixConfigDialog } from "./matrix-config"

beforeEach(() => {
  jest.clearAllMocks()
  mockProbeMatrixAccessToken.mockResolvedValue({ ok: true, userId: "@bot:matrix.org" })
})

describe("MatrixConfigDialog — create new", () => {
  it("renders the create title and homeserver + access token inputs", () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add matrix connector/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/homeserver/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^access token/i)).toBeInTheDocument()
  })

  it("blocks save when the homeserver is missing", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Homeserver"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("blocks save when the display name is blank", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "   " } })
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/^access token/i), { target: { value: "syt_secret" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Display name"))
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

  it("blocks save when quiet hours are incomplete", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/^access token/i), { target: { value: "syt_secret" } })
    fireEvent.click(screen.getByRole("button", { name: /^advanced$/i }))
    fireEvent.click(screen.getByRole("switch", { name: /enable quiet hours/i }))
    fireEvent.change(screen.getByLabelText(/quiet hours from/i), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Quiet hours"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("creates the adapter and stores the access token in the keyring", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "https://matrix.org" },
    })
    fireEvent.change(screen.getByLabelText(/^access token/i), {
      target: { value: "syt_secret" },
    })
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

  it("tests a pasted access token with Matrix whoami before saving", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "matrix.org" },
    })
    fireEvent.change(screen.getByLabelText(/^access token/i), {
      target: { value: "syt_secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))

    await waitFor(() => {
      expect(mockProbeMatrixAccessToken).toHaveBeenCalledWith("matrix.org", "syt_secret")
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("@bot:matrix.org"))
    })
    expect(screen.getByRole("status")).toHaveTextContent("@bot:matrix.org")
    expect(screen.getByRole("status")).not.toHaveTextContent("syt_secret")
  })

  it("shows a Matrix whoami error for a rejected access token", async () => {
    mockProbeMatrixAccessToken.mockResolvedValueOnce({
      ok: false,
      error: "Matrix whoami failed: Invalid access token",
    })

    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "matrix.org" },
    })
    fireEvent.change(screen.getByLabelText(/^access token/i), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Invalid access token"))
      expect(screen.getByRole("status")).toHaveTextContent("Invalid access token")
    })
  })

  it("blocks access-token testing until homeserver and token are present", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Homeserver"))
    })
    expect(mockProbeMatrixAccessToken).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "matrix.org" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("access token"))
    })
    expect(mockProbeMatrixAccessToken).not.toHaveBeenCalled()
  })

  it("shows an unexpected access-token test exception without leaking the token", async () => {
    mockProbeMatrixAccessToken.mockRejectedValueOnce(new Error("network offline"))

    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), {
      target: { value: "matrix.org" },
    })
    fireEvent.change(screen.getByLabelText(/^access token/i), { target: { value: "syt_secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("network offline"))
      expect(screen.getByRole("status")).toHaveTextContent("network offline")
    })
    expect(screen.getByRole("status")).not.toHaveTextContent("syt_secret")
  })

  it("blocks password login until required credentials are present", async () => {
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByTestId("matrix-password-login"))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Homeserver"))
    })
    expect(mockLogin).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.click(screen.getByTestId("matrix-password-login"))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("username"))
    })
    expect(mockLogin).not.toHaveBeenCalled()
  })

  it("reports password-login failures and keeps the token empty", async () => {
    mockLogin.mockRejectedValueOnce(new Error("Invalid password"))

    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bot" } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "bad" } })
    fireEvent.click(screen.getByTestId("matrix-password-login"))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Invalid password")
    })
    expect(screen.getByLabelText(/^access token/i)).toHaveValue("")
  })

  it("password login fills the token, stores deviceId, and reports the signed-in user", async () => {
    mockLogin.mockResolvedValue({
      accessToken: "syt_from_login",
      userId: "@bot:matrix.org",
      deviceId: "DEV",
    })
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bot" } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("matrix-password-login"))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("matrix.org", "bot", "pw")
    })
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { homeserver: "matrix.org", deviceId: "DEV" },
        })
      )
    })
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("@bot:matrix.org"))
  })

  it("keeps the login-captured deviceId when the token test's whoami omits device_id", async () => {
    mockLogin.mockResolvedValue({
      accessToken: "syt_from_login",
      userId: "@bot:matrix.org",
      deviceId: "DEV",
    })
    // Probe succeeds but the homeserver omits the spec-optional device_id.
    mockProbeMatrixAccessToken.mockResolvedValueOnce({ ok: true, userId: "@bot:matrix.org" })
    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "matrix.org" } })
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bot" } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "pw" } })
    fireEvent.click(screen.getByTestId("matrix-password-login"))
    await waitFor(() => expect(mockLogin).toHaveBeenCalled())

    // Test the login-filled token; the whoami response carries no device_id.
    fireEvent.click(screen.getByRole("button", { name: /test matrix access token/i }))
    await waitFor(() => expect(mockProbeMatrixAccessToken).toHaveBeenCalled())

    // Save — the deviceId captured at login must NOT have been blanked.
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { homeserver: "matrix.org", deviceId: "DEV" },
        })
      )
    })
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
    mediaModelPolicy: "local_extract_only" as const,
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

  it("reports update failures without rotating credentials", async () => {
    mockUpdateAdapterInstance.mockRejectedValueOnce(new Error("write denied"))

    render(<MatrixConfigDialog open onOpenChange={jest.fn()} row={row} />)
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("write denied")
    })
    expect(mockEmitCredentialsRotated).not.toHaveBeenCalled()
  })
})
