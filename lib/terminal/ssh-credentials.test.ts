import type { KeyringStore } from "@/lib/credentials/keyring-store"

import {
  __setSshCredentialStore,
  clearSshCredential,
  loadSshCredential,
  saveSshCredential,
} from "./ssh-credentials"

function memoryStore(): KeyringStore {
  const values = new Map<string, string>()
  return {
    save: async (key, value) => {
      values.set(key, value)
    },
    load: async (key) => values.get(key) ?? null,
    delete: async (key) => {
      values.delete(key)
    },
  }
}

describe("SSH credentials", () => {
  beforeEach(() => {
    __setSshCredentialStore(memoryStore())
  })

  afterAll(() => {
    __setSshCredentialStore(null)
  })

  it("round-trips a password without exposing it in a profile shape", async () => {
    await saveSshCredential("ssh-1", { password: "  correct horse  " })
    expect(await loadSshCredential("ssh-1")).toEqual({ password: "  correct horse  " })
  })

  it("stores a private-key passphrase and clears it idempotently", async () => {
    await saveSshCredential("ssh-2", { passphrase: "key secret" })
    expect(await loadSshCredential("ssh-2")).toEqual({ passphrase: "key secret" })
    await clearSshCredential("ssh-2")
    await clearSshCredential("ssh-2")
    expect(await loadSshCredential("ssh-2")).toBeNull()
  })

  it("rejects empty credentials instead of writing ambiguous keyring data", async () => {
    await expect(saveSshCredential("ssh-1", {})).rejects.toThrow("credential")
    await expect(saveSshCredential(" ", { password: "secret" })).rejects.toThrow("profile")
  })

  it("rejects malformed keyring payloads", async () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"password":42}',
      '{"passphrase":42}',
      "{}",
      '{"password":""}',
    ]) {
      __setSshCredentialStore({
        save: jest.fn(),
        load: jest.fn(async () => raw),
        delete: jest.fn(),
      })
      await expect(loadSshCredential("ssh-1")).rejects.toThrow("invalid")
    }
  })

  it("round-trips both supported credential fields", async () => {
    await saveSshCredential("ssh-3", { password: "secret", passphrase: "phrase" })
    expect(await loadSshCredential("ssh-3")).toEqual({
      password: "secret",
      passphrase: "phrase",
    })
  })
})
