/** @jest-environment jsdom */
import type { AppSettings } from "@cognia/agent-config-types"

const settingsState: { current: Partial<AppSettings> } = { current: {} }
const saveSettingsMock = jest.fn(async (patch: Partial<AppSettings>) => {
  settingsState.current = { ...settingsState.current, ...patch }
  return settingsState.current as AppSettings
})
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settingsState.current,
  saveSettings: (patch: Partial<AppSettings>) => saveSettingsMock(patch),
}))

const providerSessions: Record<string, unknown[]> = {}
const resolveRequestCredential = jest.fn(async () => ({ accessToken: "installation-token" }))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  getProvider: (id: string) =>
    providerSessions[id]
      ? {
          id,
          getSessions: async () => providerSessions[id],
          resolveRequestCredential: id === "github-app" ? resolveRequestCredential : undefined,
        }
      : undefined,
}))

import {
  DEFAULT_GITHUB_BACKUP_PATH,
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
  __setBackupDestinationSecretStoreForTesting,
  clearGithubBackupToken,
  clearGoogleDriveTokens,
  describeBackupDestinationReadiness,
  getBackupDestinationsSettings,
  getGithubBackupToken,
  getGoogleDriveClientSecret,
  isDeprecatedBackupDestination,
  loadGoogleDriveTokens,
  normalizeGithubPath,
  parseRepoFullName,
  resolveGithubBackupConfig,
  resolveGoogleDriveBackupConfig,
  saveGoogleDriveTokens,
  setGithubBackupToken,
  setGoogleDriveClientSecret,
  updateBackupDestinationsSettings,
} from "./config"

class MemoryStore {
  data = new Map<string, string>()
  async save(k: string, v: string) {
    this.data.set(k, v)
  }
  async load(k: string) {
    return this.data.get(k) ?? null
  }
  async delete(k: string) {
    this.data.delete(k)
  }
}

let store: MemoryStore

beforeEach(() => {
  store = new MemoryStore()
  __setBackupDestinationSecretStoreForTesting(store)
  settingsState.current = {}
  saveSettingsMock.mockClear()
  for (const key of Object.keys(providerSessions)) delete providerSessions[key]
})

afterAll(() => __setBackupDestinationSecretStoreForTesting(null))

describe("repo/path normalisation", () => {
  it("parses owner/name in several spellings", () => {
    expect(parseRepoFullName("octo/repo")).toEqual({ owner: "octo", repo: "repo" })
    expect(parseRepoFullName(" https://github.com/octo/repo.git ")).toEqual({
      owner: "octo",
      repo: "repo",
    })
    expect(parseRepoFullName("octo")).toBeNull()
    expect(parseRepoFullName("-bad/repo")).toBeNull()
    expect(parseRepoFullName(undefined)).toBeNull()
  })

  it("normalises the in-repo path and refuses traversal", () => {
    expect(normalizeGithubPath(undefined)).toBe(DEFAULT_GITHUB_BACKUP_PATH)
    expect(normalizeGithubPath("/backups/cognia/")).toBe("backups/cognia")
    expect(normalizeGithubPath("../etc")).toBe(DEFAULT_GITHUB_BACKUP_PATH)
  })

  it("flags convex as deprecated", () => {
    expect(isDeprecatedBackupDestination("convex")).toBe(true)
    expect(isDeprecatedBackupDestination("github")).toBe(false)
    expect(isDeprecatedBackupDestination(undefined)).toBe(false)
  })
})

describe("settings access", () => {
  it("reads, patches and functionally updates backupDestinations", async () => {
    expect(await getBackupDestinationsSettings()).toEqual({})
    await updateBackupDestinationsSettings({ github: { enabled: true, repo: "o/r" } })
    expect(saveSettingsMock).toHaveBeenLastCalledWith({
      backupDestinations: { github: { enabled: true, repo: "o/r" } },
    })
    await updateBackupDestinationsSettings((current) => ({
      ...current,
      googleDrive: { enabled: true, clientId: "cid" },
    }))
    expect((await getBackupDestinationsSettings()).googleDrive).toEqual({
      enabled: true,
      clientId: "cid",
    })
  })

  it("tolerates a failing settings read", async () => {
    settingsState.current = null as unknown as Partial<AppSettings>
    expect(await getBackupDestinationsSettings()).toEqual({})
  })
})

describe("github config + token", () => {
  it("resolves an enabled config with defaults and the keyring credential", () => {
    expect(resolveGithubBackupConfig(undefined)).toBeNull()
    expect(resolveGithubBackupConfig({ enabled: false, repo: "o/r" })).toBeNull()
    expect(
      resolveGithubBackupConfig({ enabled: false, repo: "o/r" }, { requireEnabled: false })
    ).toMatchObject({
      repoFullName: "o/r",
    })
    expect(resolveGithubBackupConfig({ enabled: true, repo: "nope" })).toBeNull()
    expect(
      resolveGithubBackupConfig({ enabled: true, repo: "o/r", branch: " main ", path: "/x/" })
    ).toEqual({
      owner: "o",
      repo: "r",
      repoFullName: "o/r",
      branch: "main",
      path: "x",
      credential: { kind: "keyring" },
    })
  })

  it("stores, loads and clears the keyring token", async () => {
    await expect(setGithubBackupToken("  ")).rejects.toThrow(/empty/)
    await setGithubBackupToken(" ghp_x ")
    expect(await getGithubBackupToken({ kind: "keyring" })).toBe("ghp_x")
    await clearGithubBackupToken()
    expect(await getGithubBackupToken({ kind: "keyring" })).toBeNull()
  })

  it("reuses github-pat / github-app auth sessions", async () => {
    providerSessions["github-pat"] = [{ id: "s1", accessToken: "pat-token", account: { id: "a" } }]
    providerSessions["github-app"] = [{ id: "s2", accessToken: "jwt", account: { id: "b" } }]
    expect(
      await getGithubBackupToken({
        kind: "auth-session",
        providerId: "github-pat",
        sessionId: "s1",
      })
    ).toBe("pat-token")
    expect(
      await getGithubBackupToken({
        kind: "auth-session",
        providerId: "github-app",
        sessionId: "s2",
      })
    ).toBe("installation-token")
    expect(
      await getGithubBackupToken({
        kind: "auth-session",
        providerId: "github-pat",
        sessionId: "missing",
      })
    ).toBeNull()
    expect(
      await getGithubBackupToken({
        kind: "auth-session",
        providerId: "github-app",
        sessionId: "s2",
      })
    ).toBe("installation-token")
    delete providerSessions["github-pat"]
    expect(
      await getGithubBackupToken({
        kind: "auth-session",
        providerId: "github-pat",
        sessionId: "s1",
      })
    ).toBeNull()
  })
})

describe("google drive config + secrets", () => {
  it("resolves the config with a default folder name", () => {
    expect(resolveGoogleDriveBackupConfig(undefined)).toBeNull()
    expect(resolveGoogleDriveBackupConfig({ enabled: true })).toBeNull()
    expect(resolveGoogleDriveBackupConfig({ enabled: true, clientId: " cid " })).toEqual({
      clientId: "cid",
      folderName: DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
      folderId: undefined,
    })
    expect(
      resolveGoogleDriveBackupConfig(
        { enabled: false, clientId: "cid", folderId: "f" },
        { requireEnabled: false }
      )
    ).toMatchObject({ folderId: "f" })
  })

  it("stores the client secret and the token blob", async () => {
    await expect(setGoogleDriveClientSecret("")).rejects.toThrow(/empty/)
    await setGoogleDriveClientSecret("sec")
    expect(await getGoogleDriveClientSecret()).toBe("sec")
    expect(await loadGoogleDriveTokens()).toBeNull()
    await saveGoogleDriveTokens({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 5,
      scope: "s",
      tokenType: "Bearer",
    })
    expect(await loadGoogleDriveTokens()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 5,
      scope: "s",
      tokenType: "Bearer",
    })
    await store.save("google-drive-tokens", "{bad")
    expect(await loadGoogleDriveTokens()).toBeNull()
    await store.save("google-drive-tokens", JSON.stringify({ accessToken: 1 }))
    expect(await loadGoogleDriveTokens()).toBeNull()
    await clearGoogleDriveTokens()
    expect(await loadGoogleDriveTokens()).toBeNull()
  })
})

describe("readiness matrix", () => {
  it("reports local ready, remotes by configuration, convex deprecated", async () => {
    let readiness = await describeBackupDestinationReadiness()
    expect(readiness).toEqual([
      { destination: "local", state: "ready" },
      { destination: "github", state: "not-configured", reason: "github" },
      { destination: "googledrive", state: "not-configured", reason: "googledrive" },
      { destination: "convex", state: "deprecated" },
    ])
    settingsState.current = {
      backupDestinations: {
        github: { enabled: true, repo: "o/r" },
        googleDrive: { enabled: true, clientId: "cid" },
      },
    }
    await saveGoogleDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    readiness = await describeBackupDestinationReadiness()
    expect(readiness.find((r) => r.destination === "github")?.state).toBe("ready")
    expect(readiness.find((r) => r.destination === "googledrive")?.state).toBe("ready")
  })
})
