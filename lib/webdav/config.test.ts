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
  WEBDAV_PASSWORD_REF,
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
