/**
 * @jest-environment node
 */
import path from "node:path"

import {
  setCredential,
  deleteCredential,
  listCredentialProviders,
  CREDENTIALS_MODE,
  type CredentialsFs,
} from "./credentials"
import { credentialsPath } from "./load"

const HOME = "/home/u/.cognia"

/** In-memory CredentialsFs that records the last write mode + mkdirp calls. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: Array<{ path: string; mode: number }> = []
  const dirs: string[] = []
  const fsx: CredentialsFs = {
    read: (p) => (files.has(p) ? files.get(p)! : null),
    write: (p, content, mode) => {
      files.set(p, content)
      writes.push({ path: p, mode })
    },
    mkdirp: (dir) => {
      dirs.push(dir)
    },
    dirname: (p) => path.dirname(p),
  }
  return { fsx, files, writes, dirs }
}

describe("setCredential", () => {
  it("writes a new credentials.json with 0600 perms", () => {
    const m = memFs()
    const target = setCredential(HOME, "anthropic", "sk-1", m.fsx)
    expect(target).toBe(credentialsPath(HOME))
    expect(m.writes[0].mode).toBe(CREDENTIALS_MODE)
    expect(m.dirs[0]).toBe(path.dirname(credentialsPath(HOME)))
    const parsed = JSON.parse(m.files.get(target)!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-1")
  })

  it("preserves other providers when adding a key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { openai: { apiKey: "sk-o" } } }),
    })
    setCredential(HOME, "anthropic", "sk-a", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.openai.apiKey).toBe("sk-o")
    expect(parsed.providers.anthropic.apiKey).toBe("sk-a")
  })

  it("replaces an existing key for the same provider", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { anthropic: { apiKey: "old" } } }),
    })
    setCredential(HOME, "anthropic", "new", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("new")
  })

  it("stores a subscription token without wiping an existing api key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { anthropic: { apiKey: "sk-keep" } } }),
    })
    setCredential(HOME, "anthropic", "oauth-tok", m.fsx, { kind: "authToken" })
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-keep")
    expect(parsed.providers.anthropic.authToken).toBe("oauth-tok")
  })

  it("rejects an empty key", () => {
    const m = memFs()
    expect(() => setCredential(HOME, "anthropic", "   ", m.fsx)).toThrow(/must not be empty/)
  })

  it("throws on corrupt existing credentials.json", () => {
    const m = memFs({ [credentialsPath(HOME)]: "{bad" })
    expect(() => setCredential(HOME, "anthropic", "sk", m.fsx)).toThrow(/invalid JSON/)
  })
})

describe("deleteCredential", () => {
  it("removes one provider's key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "o" } },
      }),
    })
    deleteCredential(HOME, "anthropic", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic).toBeUndefined()
    expect(parsed.providers.openai.apiKey).toBe("o")
  })

  it("is a no-op when the provider has no stored key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { openai: { apiKey: "o" } } }),
    })
    deleteCredential(HOME, "anthropic", m.fsx)
    expect(m.writes).toHaveLength(0)
  })

  it("is a no-op when no credentials file exists", () => {
    const m = memFs()
    deleteCredential(HOME, "anthropic", m.fsx)
    expect(m.writes).toHaveLength(0)
  })
})

describe("listCredentialProviders", () => {
  it("lists stored provider ids sorted", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "a" } },
      }),
    })
    expect(listCredentialProviders(HOME, m.fsx)).toEqual(["anthropic", "openai"])
  })

  it("returns [] when no credentials file exists", () => {
    const m = memFs()
    expect(listCredentialProviders(HOME, m.fsx)).toEqual([])
  })
})
