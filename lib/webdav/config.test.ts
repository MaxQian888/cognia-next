import type { AppSettings } from "@/lib/claude/types"

let settings: Partial<AppSettings> = {}
const secrets = new Map<string, string>()

jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settings,
}))

jest.mock("@/lib/keyring", () => ({
  getSecret: async (ref: { namespace: string; key: string }) =>
    secrets.get(`${ref.namespace}:${ref.key}`) ?? null,
  setSecret: async (ref: { namespace: string; key: string }, value: string) => {
    secrets.set(`${ref.namespace}:${ref.key}`, value)
  },
  clearSecret: async (ref: { namespace: string; key: string }) => {
    secrets.delete(`${ref.namespace}:${ref.key}`)
  },
}))

const createWebDavClientMock = jest.fn((..._args: unknown[]) => ({ marker: "client" }))
jest.mock("./client", () => ({
  createWebDavClient: (...args: unknown[]) => createWebDavClientMock(...args),
}))

import {
  resolveWebDavConfig,
  setWebDavPassword,
  hasWebDavPassword,
  makeWebDavClient,
  setStoredSyncPassphrase,
  getStoredSyncPassphrase,
  clearStoredSyncPassphrase,
  hasStoredSyncPassphrase,
  WEBDAV_PASSWORD_REF,
  WEBDAV_PASSPHRASE_REF,
  DEFAULT_WEBDAV_REMOTE_DIR,
} from "./config"

beforeEach(() => {
  settings = {}
  secrets.clear()
  createWebDavClientMock.mockClear()
})

const PWD_KEY = `${WEBDAV_PASSWORD_REF.namespace}:${WEBDAV_PASSWORD_REF.key}`

describe("resolveWebDavConfig", () => {
  it("returns null when disabled", async () => {
    settings = { webdavSync: { enabled: false, baseUrl: "https://d", username: "u" } }
    secrets.set(PWD_KEY, "p")
    expect(await resolveWebDavConfig()).toBeNull()
  })

  it("returns null when url/username/password incomplete", async () => {
    settings = { webdavSync: { enabled: true, baseUrl: "https://d" } }
    expect(await resolveWebDavConfig()).toBeNull()

    settings = { webdavSync: { enabled: true, baseUrl: "https://d", username: "u" } }
    expect(await resolveWebDavConfig()).toBeNull() // no password
  })

  it("normalizes base url + dir and includes the password", async () => {
    settings = {
      webdavSync: {
        enabled: true,
        baseUrl: "https://d.example.com/",
        username: "u",
        remoteDir: "backups/",
      },
    }
    secrets.set(PWD_KEY, "p")
    const cfg = await resolveWebDavConfig()
    expect(cfg).toEqual({
      baseUrl: "https://d.example.com",
      username: "u",
      remoteDir: "/backups",
      password: "p",
    })
  })

  it("defaults remoteDir when unset", async () => {
    settings = { webdavSync: { enabled: true, baseUrl: "https://d", username: "u" } }
    secrets.set(PWD_KEY, "p")
    const cfg = await resolveWebDavConfig()
    expect(cfg?.remoteDir).toBe(DEFAULT_WEBDAV_REMOTE_DIR)
  })
})

describe("password helpers", () => {
  it("sets, reports, and clears the keyring password", async () => {
    expect(await hasWebDavPassword()).toBe(false)
    await setWebDavPassword("p")
    expect(await hasWebDavPassword()).toBe(true)
    await setWebDavPassword("")
    expect(await hasWebDavPassword()).toBe(false)
  })
})

describe("stored sync passphrase helpers", () => {
  const PASS_KEY = `${WEBDAV_PASSPHRASE_REF.namespace}:${WEBDAV_PASSPHRASE_REF.key}`

  it("lives in the same keyring namespace as the server password", () => {
    expect(WEBDAV_PASSPHRASE_REF.namespace).toBe(WEBDAV_PASSWORD_REF.namespace)
    expect(WEBDAV_PASSPHRASE_REF.key).not.toBe(WEBDAV_PASSWORD_REF.key)
  })

  it("sets, reads, reports, and clears the persisted passphrase", async () => {
    expect(await hasStoredSyncPassphrase()).toBe(false)
    expect(await getStoredSyncPassphrase()).toBeNull()

    await setStoredSyncPassphrase("correct horse")
    expect(secrets.get(PASS_KEY)).toBe("correct horse")
    expect(await hasStoredSyncPassphrase()).toBe(true)
    expect(await getStoredSyncPassphrase()).toBe("correct horse")

    await clearStoredSyncPassphrase()
    expect(await hasStoredSyncPassphrase()).toBe(false)
  })

  it("setStoredSyncPassphrase('') clears instead of storing empty", async () => {
    await setStoredSyncPassphrase("x")
    await setStoredSyncPassphrase("")
    expect(await hasStoredSyncPassphrase()).toBe(false)
  })

  it("does not collide with the server password slot", async () => {
    await setWebDavPassword("server-pwd")
    await setStoredSyncPassphrase("sync-pass")
    expect(await getStoredSyncPassphrase()).toBe("sync-pass")
    expect(secrets.get(PWD_KEY)).toBe("server-pwd")
  })
})

describe("makeWebDavClient", () => {
  it("returns null when not configured", async () => {
    expect(await makeWebDavClient()).toBeNull()
  })

  it("builds a client + config when configured", async () => {
    settings = { webdavSync: { enabled: true, baseUrl: "https://d", username: "u" } }
    secrets.set(PWD_KEY, "p")
    const made = await makeWebDavClient()
    expect(made?.config.baseUrl).toBe("https://d")
    expect(createWebDavClientMock).toHaveBeenCalledWith(
      { baseUrl: "https://d", username: "u", password: "p" },
      { trustSelfSigned: true }
    )
  })
})
