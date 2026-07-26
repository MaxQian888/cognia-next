import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let storedSettings: { webdavSync?: Record<string, unknown> } = {}
const saveSettingsMock = jest.fn(async (..._a: unknown[]) => {})
const setWebDavPasswordMock = jest.fn(async (..._a: unknown[]) => {})
const getWebDavPasswordMock = jest.fn(async (..._a: unknown[]) => "stored-pwd")
let hasPassword = false
const setSyncPassphraseMock = jest.fn()
let hasPass = false
const runSyncNowMock = jest.fn(
  async (..._a: unknown[]): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
)
const ensureCollectionMock = jest.fn(async () => {})
const createWebDavClientMock = jest.fn((..._a: unknown[]) => ({
  ensureCollection: ensureCollectionMock,
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => storedSettings,
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))
const clearStoredSyncPassphraseMock = jest.fn(async (..._a: unknown[]) => {})
jest.mock("@/lib/webdav/config", () => ({
  DEFAULT_WEBDAV_REMOTE_DIR: "/cognia-backups",
  hasWebDavPassword: async () => hasPassword,
  setWebDavPassword: (...a: unknown[]) => setWebDavPasswordMock(...a),
  getWebDavPassword: (...a: unknown[]) => getWebDavPasswordMock(...a),
  clearStoredSyncPassphrase: (...a: unknown[]) => clearStoredSyncPassphraseMock(...a),
}))
jest.mock("@/lib/webdav/client", () => ({
  createWebDavClient: (...a: unknown[]) => createWebDavClientMock(...a),
}))
let supported = true
jest.mock("@/lib/webdav/transport", () => ({
  isWebDavSupported: () => supported,
}))
const loadPersistedMock = jest.fn(async (..._a: unknown[]) => false)
const persistSyncPassphraseMock = jest.fn(async (..._a: unknown[]) => {})
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  setSyncPassphrase: (...a: unknown[]) => setSyncPassphraseMock(...a),
  hasSyncPassphrase: () => hasPass,
  getSyncPassphrase: () => (hasPass ? "cached-pass" : null),
  loadPersistedSyncPassphrase: (...a: unknown[]) => loadPersistedMock(...a),
  persistSyncPassphrase: (...a: unknown[]) => persistSyncPassphraseMock(...a),
}))
jest.mock("@/lib/db/backup-history", () => ({
  listBackupHistory: jest.fn(async () => []),
}))
jest.mock("@/lib/webdav/sync-now", () => ({
  runWebDavSyncNow: (...a: unknown[]) => runSyncNowMock(...a),
}))
// Stub the restore dialog so we don't drag the restore pipeline into this test.
jest.mock("@/components/data/import/webdav-restore-dialog", () => ({
  WebDavRestoreDialog: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))
const routerPushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}))
const startNewSessionMock = jest.fn(async (..._a: unknown[]) => ({ id: "ai-session" }))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...a: unknown[]) => startNewSessionMock(...a),
}))
const queuePendingChatPromptMock = jest.fn()
jest.mock("@/lib/chat/pending-prompt", () => ({
  queuePendingChatPrompt: (...a: unknown[]) => queuePendingChatPromptMock(...a),
}))

import { WebDavSyncCard } from "./webdav-sync-card"

beforeEach(() => {
  storedSettings = {}
  hasPassword = false
  hasPass = false
  supported = true
  saveSettingsMock.mockClear()
  setWebDavPasswordMock.mockClear()
  setSyncPassphraseMock.mockClear()
  runSyncNowMock.mockClear()
  runSyncNowMock.mockResolvedValue({ ok: true })
  ensureCollectionMock.mockClear()
  createWebDavClientMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  loadPersistedMock.mockClear()
  persistSyncPassphraseMock.mockClear()
  clearStoredSyncPassphraseMock.mockClear()
  routerPushMock.mockClear()
  startNewSessionMock.mockClear()
  startNewSessionMock.mockResolvedValue({ id: "ai-session" })
  queuePendingChatPromptMock.mockClear()
})

describe("WebDavSyncCard", () => {
  it("hydrates from settings", async () => {
    storedSettings = { webdavSync: { enabled: true, baseUrl: "https://d", username: "bob" } }
    render(<WebDavSyncCard />)
    await waitFor(() => expect(screen.getByDisplayValue("https://d")).toBeInTheDocument())
    expect(screen.getByDisplayValue("bob")).toBeInTheDocument()
  })

  it("saves settings + password + passphrase", async () => {
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))

    await user.type(screen.getByLabelText("Server URL"), "https://dav.example.com")
    await user.type(screen.getByLabelText("Username"), "bob")
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.type(screen.getByLabelText("Sync passphrase"), "secret")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webdavSync: expect.objectContaining({
          baseUrl: "https://dav.example.com",
          username: "bob",
        }),
      })
    )
    expect(setWebDavPasswordMock).toHaveBeenCalledWith("pw")
    expect(setSyncPassphraseMock).toHaveBeenCalledWith("secret")
  })

  it("test connection ensures the remote collection", async () => {
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))
    await user.type(screen.getByLabelText("Server URL"), "https://d")
    await user.type(screen.getByLabelText("Username"), "bob")
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Test connection" }))
    await waitFor(() => expect(ensureCollectionMock).toHaveBeenCalled())
    expect(createWebDavClientMock).toHaveBeenCalledWith(expect.any(Object), {
      trustSelfSigned: false,
    })
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("uses invalid certificates only after explicit opt-in and persists the choice", async () => {
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))

    const toggle = screen.getByTestId("webdav-allow-invalid-certificates")
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    await user.click(toggle)
    await user.type(screen.getByLabelText("Server URL"), "https://nas.example")
    await user.type(screen.getByLabelText("Username"), "bob")
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Test connection" }))

    await waitFor(() =>
      expect(createWebDavClientMock).toHaveBeenCalledWith(expect.any(Object), {
        trustSelfSigned: true,
      })
    )

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          webdavSync: expect.objectContaining({ allowInvalidCertificates: true }),
        })
      )
    )
  })

  it("starts a normal chat with credential-free AI configuration instructions", async () => {
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))

    await user.type(screen.getByLabelText("Server URL"), "https://private.example")
    await user.type(screen.getByLabelText("Username"), "private-user")
    await user.type(screen.getByLabelText("Password"), "private-password")
    await user.click(screen.getByRole("button", { name: "Configure with AI" }))

    await waitFor(() => expect(startNewSessionMock).toHaveBeenCalled())
    expect(queuePendingChatPromptMock).toHaveBeenCalledWith(
      "ai-session",
      expect.stringContaining("WebDAV")
    )
    const prompt = queuePendingChatPromptMock.mock.calls[0]?.[1] as string
    expect(prompt).not.toContain("private.example")
    expect(prompt).not.toContain("private-user")
    expect(prompt).not.toContain("private-password")
    expect(routerPushMock).toHaveBeenCalledWith("/")
  })

  it("sync now requires a passphrase, then uploads", async () => {
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))

    await user.click(screen.getByRole("button", { name: "Sync now" }))
    expect(toastError).toHaveBeenCalled()
    expect(runSyncNowMock).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText("Sync passphrase"), "secret")
    await user.click(screen.getByRole("button", { name: "Sync now" }))
    await waitFor(() =>
      expect(runSyncNowMock).toHaveBeenCalledWith(
        "secret",
        expect.objectContaining({ onProgress: expect.any(Function) })
      )
    )
  })

  it("hydrates the persisted passphrase on mount (opt-in unattended unlock)", async () => {
    loadPersistedMock.mockImplementation(async () => {
      hasPass = true
      return true
    })
    render(<WebDavSyncCard />)
    await waitFor(() => expect(loadPersistedMock).toHaveBeenCalled())
    // The unlocked badge appears without any user input.
    await waitFor(() => expect(screen.getByText("Unlocked")).toBeInTheDocument())
  })

  it("remember toggle persists the cached passphrase when turned on", async () => {
    hasPass = true
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))

    await user.click(screen.getByTestId("webdav-remember-passphrase"))
    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          webdavSync: expect.objectContaining({ rememberPassphrase: true }),
        })
      )
    )
    expect(persistSyncPassphraseMock).toHaveBeenCalledWith("cached-pass")
  })

  it("remember toggle wipes the keyring copy when turned off", async () => {
    storedSettings = { webdavSync: { rememberPassphrase: true } }
    const user = userEvent.setup()
    render(<WebDavSyncCard />)
    await waitFor(() => screen.getByText("WebDAV sync"))
    const toggle = screen.getByTestId("webdav-remember-passphrase")
    await waitFor(() => expect(toggle).toHaveAttribute("data-state", "checked"))

    await user.click(toggle)
    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          webdavSync: expect.objectContaining({ rememberPassphrase: false }),
        })
      )
    )
    expect(clearStoredSyncPassphraseMock).toHaveBeenCalled()
    expect(persistSyncPassphraseMock).not.toHaveBeenCalled()
  })

  it("disables network actions and shows a note on web", async () => {
    supported = false
    render(<WebDavSyncCard />)
    await waitFor(() =>
      expect(
        screen.getByText(/WebDAV sync runs in the desktop and mobile apps only/)
      ).toBeInTheDocument()
    )
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled()
    // Save still works — persisting config is fine anywhere.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })
})
