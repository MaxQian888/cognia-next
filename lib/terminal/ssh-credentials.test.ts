import type { KeyringStore } from "@/lib/credentials/keyring-store"

import { __setSshCredentialStore, clearSshCredential, saveSshCredential } from "./ssh-credentials"

/**
 * Assertions read the keyring's raw bytes rather than a TypeScript reader,
 * because there is no TypeScript reader: `crates/cognia-terminal/src/ssh.rs`
 * parses these entries natively at connect time. Pinning the stored JSON is
 * therefore pinning the actual contract between the two sides, which a
 * round-trip through a parser of our own would not have done.
 */
function memoryStore(): KeyringStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
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
  let store: ReturnType<typeof memoryStore>

  beforeEach(() => {
    store = memoryStore()
    __setSshCredentialStore(store)
  })

  afterAll(() => {
    __setSshCredentialStore(null)
  })

  it("stores a password verbatim, whitespace included", async () => {
    await saveSshCredential("ssh-1", { password: "  correct horse  " })
    expect(JSON.parse(store.values.get("ssh-1") ?? "null")).toEqual({
      password: "  correct horse  ",
    })
  })

  it("stores a private-key passphrase and clears it idempotently", async () => {
    await saveSshCredential("ssh-2", { passphrase: "key secret" })
    expect(store.values.has("ssh-2")).toBe(true)
    await clearSshCredential("ssh-2")
    await clearSshCredential("ssh-2")
    expect(store.values.has("ssh-2")).toBe(false)
  })

  it("rejects empty credentials instead of writing ambiguous keyring data", async () => {
    await expect(saveSshCredential("ssh-1", {})).rejects.toThrow("credential")
    await expect(saveSshCredential(" ", { password: "secret" })).rejects.toThrow("profile")
    expect(store.values.size).toBe(0)
  })

  it("rejects a profile id carrying control characters", async () => {
    const hostile = `ssh${String.fromCharCode(1)}1`
    await expect(saveSshCredential(hostile, { password: "x" })).rejects.toThrow("profile")
    await expect(clearSshCredential(hostile)).rejects.toThrow("profile")
  })

  it("stores both supported credential fields together", async () => {
    await saveSshCredential("ssh-3", { password: "secret", passphrase: "phrase" })
    expect(JSON.parse(store.values.get("ssh-3") ?? "null")).toEqual({
      password: "secret",
      passphrase: "phrase",
    })
  })

  /**
   * The absence of a reader is the security property, so it is asserted rather
   * than left to a reviewer to notice. Re-adding one puts a stored secret back
   * within reach of the renderer and has to argue for itself here first.
   */
  it("exposes no reader, so a stored secret cannot be read back into the renderer", async () => {
    const surface = await import("./ssh-credentials")
    expect(Object.keys(surface).sort()).toEqual([
      "SSH_CREDENTIAL_NAMESPACE",
      "__setSshCredentialStore",
      "clearSshCredential",
      "saveSshCredential",
    ])
  })
})
