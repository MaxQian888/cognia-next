/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const settingsState: { current: Record<string, unknown> } = { current: {} }
const updateMock = jest.fn(async (patch: unknown) => {
  const next =
    typeof patch === "function" ? (patch as (c: unknown) => unknown)(settingsState.current) : patch
  settingsState.current = next as Record<string, unknown>
  return next
})
const secretState = { secret: null as string | null }
const setSecretMock = jest.fn(async (s: string) => {
  secretState.secret = s.trim()
})
const clearTokensMock = jest.fn(async () => undefined)
jest.mock("@/lib/data/destinations/config", () => ({
  ...jest.requireActual("@/lib/data/destinations/config"),
  getBackupDestinationsSettings: async () => settingsState.current,
  updateBackupDestinationsSettings: (patch: unknown) => updateMock(patch),
  getGoogleDriveClientSecret: async () => secretState.secret,
  setGoogleDriveClientSecret: (s: string) => setSecretMock(s),
  clearGoogleDriveTokens: () => clearTokensMock(),
}))
const beginMock = jest.fn()
const completeMock = jest.fn()
jest.mock("@/lib/data/destinations/google-oauth", () => ({
  beginGoogleDeviceAuth: () => beginMock(),
  completeGoogleDeviceAuth: (...a: unknown[]) => completeMock(...a),
}))
const syncMock = jest.fn()
jest.mock("@/lib/data/destinations/sync-now", () => ({
  runRemoteBackupSyncNow: (...a: unknown[]) => syncMock(...a),
}))
const passphraseState = { unlocked: true }
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  hasSyncPassphrase: () => passphraseState.unlocked,
  loadPersistedSyncPassphrase: async () => passphraseState.unlocked,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { GoogleDriveBackupCard } from "./google-drive-backup-card"

const challenge = {
  deviceCode: "dc",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://www.google.com/device",
  intervalSeconds: 5,
  expiresAt: Date.now() + 100_000,
}

beforeEach(() => {
  settingsState.current = {}
  secretState.secret = null
  passphraseState.unlocked = true
  jest.clearAllMocks()
})

describe("GoogleDriveBackupCard", () => {
  it("requires a client id to save and stores the secret in the keyring", async () => {
    render(<GoogleDriveBackupCard />)
    await waitFor(() => expect(screen.getByTestId("google-drive-save")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("google-drive-save"))
    expect(toast.error).toHaveBeenCalled()
    fireEvent.change(screen.getByTestId("google-drive-client-id"), { target: { value: " cid " } })
    fireEvent.change(screen.getByTestId("google-drive-client-secret"), { target: { value: "sec" } })
    fireEvent.change(screen.getByTestId("google-drive-folder"), { target: { value: "" } })
    fireEvent.click(screen.getByTestId("google-drive-save"))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    expect(setSecretMock).toHaveBeenCalledWith("sec")
    expect(settingsState.current).toMatchObject({
      googleDrive: { clientId: "cid", folderName: "Cognia Backups" },
    })
  })

  it("connect is disabled until client id + secret exist, then runs the device flow", async () => {
    settingsState.current = { googleDrive: { enabled: true, clientId: "cid" } }
    secretState.secret = "sec"
    beginMock.mockResolvedValue(challenge)
    let resolveComplete: (v: unknown) => void = () => undefined
    completeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveComplete = resolve
        })
    )
    render(<GoogleDriveBackupCard />)
    await waitFor(() => expect(screen.getByTestId("google-drive-connect")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("google-drive-connect"))
    await waitFor(() => expect(screen.getByTestId("google-drive-device-code")).toBeInTheDocument())
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument()
    settingsState.current = {
      googleDrive: { enabled: true, clientId: "cid", accountEmail: "me@x" },
    }
    resolveComplete({ status: "authorized", tokens: { accessToken: "a", expiresAt: 1 } })
    await waitFor(() =>
      expect(screen.getByTestId("google-drive-connected-badge")).toBeInTheDocument()
    )
    expect(toast.success).toHaveBeenCalled()
    // Disconnect clears the tokens.
    fireEvent.click(screen.getByTestId("google-drive-disconnect"))
    await waitFor(() => expect(clearTokensMock).toHaveBeenCalled())
  })

  it("reports denied / expired / error outcomes and lets the user cancel", async () => {
    settingsState.current = { googleDrive: { enabled: true, clientId: "cid" } }
    secretState.secret = "sec"
    beginMock.mockResolvedValue(challenge)
    render(<GoogleDriveBackupCard />)
    await waitFor(() => expect(screen.getByTestId("google-drive-connect")).not.toBeDisabled())
    for (const outcome of [
      { status: "denied" },
      { status: "expired" },
      { status: "error", error: "x" },
    ]) {
      completeMock.mockResolvedValueOnce(outcome)
      fireEvent.click(screen.getByTestId("google-drive-connect"))
      await waitFor(() => expect(completeMock).toHaveBeenCalled())
      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      jest.mocked(toast.error).mockClear()
    }
    beginMock.mockRejectedValueOnce(new Error("no client"))
    fireEvent.click(screen.getByTestId("google-drive-connect"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    // Cancel aborts the in-flight poll loop through the signal.
    let signalSeen: AbortSignal | undefined
    completeMock.mockImplementation((_c: unknown, deps: { signal?: AbortSignal }) => {
      signalSeen = deps.signal
      return new Promise((resolve) =>
        deps.signal?.addEventListener("abort", () => resolve({ status: "denied" }))
      )
    })
    fireEvent.click(screen.getByTestId("google-drive-connect"))
    await waitFor(() =>
      expect(screen.getByTestId("google-drive-cancel-connect")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByTestId("google-drive-cancel-connect"))
    await waitFor(() => expect(signalSeen?.aborted).toBe(true))
  })

  it("syncs only when enabled + connected + unlocked", async () => {
    settingsState.current = { googleDrive: { enabled: true, clientId: "cid", connected: true } }
    render(<GoogleDriveBackupCard />)
    await waitFor(() => expect(screen.getByTestId("google-drive-sync")).not.toBeDisabled())
    syncMock.mockResolvedValueOnce({ ok: true })
    fireEvent.click(screen.getByTestId("google-drive-sync"))
    await waitFor(() =>
      expect(syncMock).toHaveBeenCalledWith("googledrive", "", expect.any(Object))
    )
    syncMock.mockResolvedValueOnce({ ok: false, error: "quota" })
    fireEvent.click(screen.getByTestId("google-drive-sync"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    passphraseState.unlocked = false
  })

  it("blocks sync while the passphrase is locked", async () => {
    passphraseState.unlocked = false
    settingsState.current = { googleDrive: { enabled: true, clientId: "cid", connected: true } }
    render(<GoogleDriveBackupCard />)
    await waitFor(() => expect(screen.getByTestId("google-drive-sync")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("google-drive-sync"))
    expect(syncMock).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
