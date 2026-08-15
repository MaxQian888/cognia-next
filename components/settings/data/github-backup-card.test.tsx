/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const settingsState: { current: Record<string, unknown> } = { current: {} }
const updateMock = jest.fn(async (patch: unknown) => {
  const next =
    typeof patch === "function" ? (patch as (c: unknown) => unknown)(settingsState.current) : patch
  settingsState.current = next as Record<string, unknown>
  return next
})
const secretStore = new Map<string, string>()
const setTokenMock = jest.fn(async (token: string) => {
  secretStore.set("github-token", token.trim())
})
const clearTokenMock = jest.fn(async () => {
  secretStore.delete("github-token")
})
jest.mock("@/lib/data/destinations/config", () => ({
  ...jest.requireActual("@/lib/data/destinations/config"),
  getBackupDestinationsSettings: async () => settingsState.current,
  updateBackupDestinationsSettings: (patch: unknown) => updateMock(patch),
  backupDestinationSecrets: () => ({ load: async (k: string) => secretStore.get(k) ?? null }),
  setGithubBackupToken: (t: string) => setTokenMock(t),
  clearGithubBackupToken: () => clearTokenMock(),
}))
const verifyMock = jest.fn()
jest.mock("@/lib/data/destinations/github", () => ({
  verifyGithubBackupDestination: () => verifyMock(),
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
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))
jest.mock("@/components/ui/select")

import { toast } from "sonner"
import { GithubBackupCard } from "./github-backup-card"

beforeEach(() => {
  settingsState.current = {}
  secretStore.clear()
  passphraseState.unlocked = true
  jest.clearAllMocks()
})

describe("GithubBackupCard", () => {
  it("hydrates from settings and shows the private badge", async () => {
    settingsState.current = {
      github: {
        enabled: true,
        repo: "octo/vault",
        branch: "main",
        path: "backups",
        lastVerifiedVisibility: "private",
        lastSyncAt: "2026-08-16T02:00:00.000Z",
      },
    }
    render(<GithubBackupCard authSessionsForTesting={[]} />)
    await waitFor(() =>
      expect((screen.getByTestId("github-backup-repo") as HTMLInputElement).value).toBe(
        "octo/vault"
      )
    )
    expect(screen.getByTestId("github-backup-private-badge")).toBeInTheDocument()
    expect((screen.getByTestId("github-backup-branch") as HTMLInputElement).value).toBe("main")
    expect(screen.getByTestId("github-backup-last-sync")).not.toHaveTextContent(/never/i)
  })

  it("validates the repo, saves the token to the keyring and the settings", async () => {
    render(<GithubBackupCard authSessionsForTesting={[]} />)
    await waitFor(() => expect(screen.getByTestId("github-backup-save")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("github-backup-save"))
    expect(toast.error).toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId("github-backup-repo"), { target: { value: "octo/vault" } })
    fireEvent.change(screen.getByTestId("github-backup-token"), { target: { value: " ghp_1 " } })
    fireEvent.click(screen.getByTestId("github-backup-save"))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    expect(setTokenMock).toHaveBeenCalledWith(" ghp_1 ")
    expect(settingsState.current).toMatchObject({
      github: { repo: "octo/vault", path: "cognia-backups", credential: { kind: "keyring" } },
    })
    await waitFor(() => expect(screen.getByTestId("github-backup-clear-token")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("github-backup-clear-token"))
    await waitFor(() => expect(clearTokenMock).toHaveBeenCalled())
  })

  it("verifies the repository and reflects public / private outcomes", async () => {
    render(<GithubBackupCard authSessionsForTesting={[]} />)
    await waitFor(() => expect(screen.getByTestId("github-backup-verify")).toBeInTheDocument())
    verifyMock.mockResolvedValueOnce({ ok: true, defaultBranch: "main" })
    fireEvent.click(screen.getByTestId("github-backup-verify"))
    await waitFor(() =>
      expect(screen.getByTestId("github-backup-private-badge")).toBeInTheDocument()
    )
    verifyMock.mockResolvedValueOnce({ ok: false, code: "public-repo", error: "public" })
    fireEvent.click(screen.getByTestId("github-backup-verify"))
    await waitFor(() =>
      expect(screen.getByTestId("github-backup-public-badge")).toBeInTheDocument()
    )
    expect(toast.error).toHaveBeenCalled()
  })

  it("runs Sync now only with an unlocked passphrase and an enabled destination", async () => {
    settingsState.current = { github: { enabled: true, repo: "octo/vault" } }
    passphraseState.unlocked = false
    render(<GithubBackupCard authSessionsForTesting={[]} />)
    await waitFor(() => expect(screen.getByTestId("github-backup-sync")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("github-backup-sync"))
    expect(syncMock).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it("syncs when unlocked and reports success / failure", async () => {
    settingsState.current = { github: { enabled: true, repo: "octo/vault" } }
    render(<GithubBackupCard authSessionsForTesting={[]} />)
    await waitFor(() => expect(screen.getByTestId("github-backup-sync")).not.toBeDisabled())
    syncMock.mockResolvedValueOnce({ ok: true })
    fireEvent.click(screen.getByTestId("github-backup-sync"))
    await waitFor(() => expect(syncMock).toHaveBeenCalledWith("github", "", expect.any(Object)))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    syncMock.mockResolvedValueOnce({ ok: false, error: "public" })
    fireEvent.click(screen.getByTestId("github-backup-sync"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("offers stored auth sessions as credentials", async () => {
    settingsState.current = {
      github: {
        enabled: true,
        repo: "octo/vault",
        credential: { kind: "auth-session", providerId: "github-pat", sessionId: "s1" },
      },
    }
    render(
      <GithubBackupCard
        authSessionsForTesting={[
          { providerId: "github-pat", sessionId: "s1", label: "octo (github-pat)" },
        ]}
      />
    )
    // Hydration is async: wait until the auth-session credential is applied,
    // which hides the token input.
    await waitFor(() => expect(screen.queryByTestId("github-backup-token")).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId("github-backup-save"))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    expect(settingsState.current).toMatchObject({
      github: { credential: { kind: "auth-session", providerId: "github-pat", sessionId: "s1" } },
    })
  })
})
