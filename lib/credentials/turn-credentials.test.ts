import fs from "node:fs/promises"
import path from "node:path"

import {
  KEYRING_CREDENTIAL_PREFIX,
  __setTurnCredentialBackend,
  freshCredentialKeyId,
  isKeyringSentinel,
  keyIdOfSentinel,
  loadTurnCredential,
  migrateTurnServersToKeyring,
  resolveTurnServerCredentials,
  saveTurnCredential,
  deleteTurnCredential,
} from "./turn-credentials"

class TestStore {
  readonly map = new Map<string, { username: string; credential: string }>()
  async save(keyId: string, value: { username: string; credential: string }): Promise<void> {
    this.map.set(keyId, { ...value })
  }
  async load(keyId: string): Promise<{ username: string; credential: string } | null> {
    return this.map.get(keyId) ? { ...this.map.get(keyId)! } : null
  }
  async delete(keyId: string): Promise<void> {
    this.map.delete(keyId)
  }
}

let store: TestStore
beforeEach(() => {
  store = new TestStore()
  __setTurnCredentialBackend(store)
})
afterAll(() => {
  __setTurnCredentialBackend(null)
})

describe("freshCredentialKeyId", () => {
  it("returns distinct ids across calls", () => {
    const a = freshCredentialKeyId()
    const b = freshCredentialKeyId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(8)
  })
})

describe("isKeyringSentinel + keyIdOfSentinel", () => {
  it("recognises sentinel strings", () => {
    expect(isKeyringSentinel("kr:abc-123")).toBe(true)
    expect(isKeyringSentinel("plain-credential")).toBe(false)
    expect(isKeyringSentinel(undefined)).toBe(false)
    expect(isKeyringSentinel(null)).toBe(false)
    expect(isKeyringSentinel("")).toBe(false)
  })
  it("extracts the key id", () => {
    expect(keyIdOfSentinel("kr:abc-123")).toBe("abc-123")
    expect(keyIdOfSentinel("plain")).toBe(null)
  })
  it("supports an empty-id sentinel as a separator boundary", () => {
    // Defensive: an empty id behind the prefix shouldn't crash. The
    // resolver will treat it as a missing entry.
    expect(isKeyringSentinel(KEYRING_CREDENTIAL_PREFIX)).toBe(true)
    expect(keyIdOfSentinel(KEYRING_CREDENTIAL_PREFIX)).toBe("")
  })
})

describe("save / load / delete round-trip", () => {
  it("persists a credential pair under the given keyId", async () => {
    await saveTurnCredential("k-1", { username: "alice", credential: "s3cret" })
    expect(await loadTurnCredential("k-1")).toEqual({
      username: "alice",
      credential: "s3cret",
    })
  })
  it("returns null for an absent keyId", async () => {
    expect(await loadTurnCredential("missing")).toBe(null)
  })
  it("delete is idempotent", async () => {
    await saveTurnCredential("k-1", { username: "alice", credential: "s3cret" })
    await deleteTurnCredential("k-1")
    expect(await loadTurnCredential("k-1")).toBe(null)
    await deleteTurnCredential("k-1") // again — no throw
  })
  it("overwrite replaces the previous value", async () => {
    await saveTurnCredential("k-1", { username: "alice", credential: "old" })
    await saveTurnCredential("k-1", { username: "alice2", credential: "new" })
    expect(await loadTurnCredential("k-1")).toEqual({
      username: "alice2",
      credential: "new",
    })
  })
})

describe("resolveTurnServerCredentials", () => {
  it("passes plain entries through unchanged", async () => {
    const input: RTCIceServer[] = [
      { urls: "stun:stun.example.com:3478" },
      {
        urls: "turn:turn.example.com:3478",
        username: "alice",
        credential: "s3cret",
      },
    ]
    const out = await resolveTurnServerCredentials(input)
    expect(out).toEqual(input)
  })

  it("resolves a single keyring sentinel into the real credential", async () => {
    await saveTurnCredential("k-1", { username: "alice", credential: "s3cret" })
    const out = await resolveTurnServerCredentials([
      {
        urls: "turn:turn.example.com:3478",
        username: "ignored", // overwritten by keyring value
        credential: "kr:k-1",
      },
    ])
    expect(out).toEqual([
      {
        urls: "turn:turn.example.com:3478",
        username: "alice",
        credential: "s3cret",
      },
    ])
  })

  it("strips credentials when the keyring entry is missing", async () => {
    const out = await resolveTurnServerCredentials([
      {
        urls: "turn:turn.example.com:3478",
        username: "alice",
        credential: "kr:gone",
      },
    ])
    expect(out).toEqual([{ urls: "turn:turn.example.com:3478" }])
  })

  it("migrateTurnServersToKeyring: empty input yields no migration", async () => {
    const r1 = await migrateTurnServersToKeyring(undefined)
    expect(r1.migrated).toEqual([])
    expect(r1.didMigrate).toBe(false)
    const r2 = await migrateTurnServersToKeyring([])
    expect(r2.migrated).toEqual([])
    expect(r2.didMigrate).toBe(false)
  })

  it("migrateTurnServersToKeyring: passes STUN-only entries through", async () => {
    const out = await migrateTurnServersToKeyring([{ urls: "stun:stun.example.com:3478" }])
    expect(out.didMigrate).toBe(false)
    expect(out.migrated).toEqual([{ urls: "stun:stun.example.com:3478" }])
  })

  it("migrateTurnServersToKeyring: keyring sentinels are idempotent", async () => {
    const input: RTCIceServer[] = [
      {
        urls: "turn:turn.example.com:3478",
        credential: "kr:already-migrated",
      },
    ]
    const out = await migrateTurnServersToKeyring(input)
    expect(out.didMigrate).toBe(false)
    expect(out.migrated).toEqual(input)
  })

  it("migrateTurnServersToKeyring: writes plaintext entries to keyring and replaces with sentinel", async () => {
    const input: RTCIceServer[] = [
      {
        urls: "turn:turn.example.com:3478",
        username: "alice",
        credential: "s3cret",
      },
    ]
    const out = await migrateTurnServersToKeyring(input)
    expect(out.didMigrate).toBe(true)
    expect(out.migrated).toHaveLength(1)
    const m = out.migrated[0]
    expect(m.urls).toBe("turn:turn.example.com:3478")
    expect(isKeyringSentinel(m.credential as string)).toBe(true)
    expect(m.username).toBeUndefined()
    // The keyring round-trip restores the full pair.
    const keyId = keyIdOfSentinel(m.credential as string)!
    expect(await loadTurnCredential(keyId)).toEqual({
      username: "alice",
      credential: "s3cret",
    })
  })

  it("migrateTurnServersToKeyring: mixes safely with already-migrated entries", async () => {
    const input: RTCIceServer[] = [
      { urls: "stun:stun.example.com" },
      {
        urls: "turn:legacy.example.com:3478",
        username: "alice",
        credential: "s3cret",
      },
      {
        urls: "turn:already.example.com:3478",
        credential: "kr:existing",
      },
    ]
    const out = await migrateTurnServersToKeyring(input)
    expect(out.didMigrate).toBe(true)
    expect(out.migrated).toHaveLength(3)
    expect(out.migrated[0]).toEqual({ urls: "stun:stun.example.com" })
    expect(isKeyringSentinel(out.migrated[1].credential as string)).toBe(true)
    expect(out.migrated[2]).toEqual({
      urls: "turn:already.example.com:3478",
      credential: "kr:existing",
    })
  })

  it("resolves a mix of plain + keyring entries in stable order", async () => {
    await saveTurnCredential("k-1", { username: "alice", credential: "s3cret" })
    await saveTurnCredential("k-2", { username: "bob", credential: "h0nk" })
    const out = await resolveTurnServerCredentials([
      { urls: ["stun:stun.example.com:3478"] },
      {
        urls: "turn:turn-a.example.com:3478",
        username: "ignored",
        credential: "kr:k-1",
      },
      { urls: "turn:plain.example.com:3478", username: "u", credential: "p" },
      {
        urls: "turn:turn-b.example.com:3478",
        username: "ignored",
        credential: "kr:k-2",
      },
    ])
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ urls: ["stun:stun.example.com:3478"] })
    expect(out[1]).toMatchObject({ username: "alice", credential: "s3cret" })
    expect(out[2]).toEqual({
      urls: "turn:plain.example.com:3478",
      username: "u",
      credential: "p",
    })
    expect(out[3]).toMatchObject({ username: "bob", credential: "h0nk" })
  })
})

describe("CapacitorSecureStore package name", () => {
  // Regression gate for the wrong-name bug
  // (`@capacitor-community/secure-storage-plugin`). The dynamic import in
  // `loadSecureStorage()` is wrapped in try/catch, so a MODULE_NOT_FOUND
  // surfaces silently as "TURN credentials never persist on mobile". The
  // audit caught this once; this assertion keeps it from coming back.
  //
  // The package name MUST match `mobile/package.json`'s installed entry
  // because Capacitor builds resolve modules through the mobile workspace.
  it("imports the package name that mobile/package.json actually installs", async () => {
    const src = await fs.readFile(path.join(__dirname, "turn-credentials.ts"), "utf8")
    // The loader uses a `const moduleId = "..."` indirection (mirrors
    // lib/tauri/companion-storage.ts) so the literal can appear either
    // inline or aliased. Either form must use the correct package.
    expect(src).toContain('"capacitor-secure-storage-plugin"')
    expect(src).not.toContain("@capacitor-community/secure-storage-plugin")

    const mobilePkgPath = path.join(__dirname, "..", "..", "mobile", "package.json")
    const mobilePkgRaw = await fs.readFile(mobilePkgPath, "utf8")
    const mobilePkg = JSON.parse(mobilePkgRaw) as {
      dependencies?: Record<string, string>
    }
    expect(mobilePkg.dependencies?.["capacitor-secure-storage-plugin"]).toBeDefined()
    expect(mobilePkg.dependencies?.["@capacitor-community/secure-storage-plugin"]).toBeUndefined()
  })

  it("persists through window.Capacitor.Plugins.SecureStoragePlugin on device", async () => {
    // Regression for the on-device persistence bug: the loader must read the
    // proxy `registerNativePlugins()` registers at boot, not rely on a bare
    // dynamic import that never resolves in the static-export WebView.
    const realCap = (window as { Capacitor?: unknown }).Capacitor
    const secureStore = new Map<string, string>()
    try {
      // Force the runtime to pick CapacitorSecureStore: clear the injected
      // backend, present as a native Capacitor platform, expose the proxy.
      __setTurnCredentialBackend(null)
      ;(
        window as unknown as {
          Capacitor: { isNativePlatform: () => boolean; Plugins: Record<string, unknown> }
        }
      ).Capacitor = {
        isNativePlatform: () => true,
        Plugins: {
          SecureStoragePlugin: {
            async set(opts: { key: string; value: string }) {
              secureStore.set(opts.key, opts.value)
              return { value: true }
            },
            async get(opts: { key: string }) {
              if (!secureStore.has(opts.key)) throw new Error(`absent: ${opts.key}`)
              return { value: secureStore.get(opts.key)! }
            },
            async remove(opts: { key: string }) {
              secureStore.delete(opts.key)
              return { value: true }
            },
          },
        },
      }

      await saveTurnCredential("k-dev", { username: "alice", credential: "s3cret" })
      // Stored under the namespaced key in the secure store…
      expect(secureStore.get("webrtc-turn.k-dev")).toBe(
        JSON.stringify({ username: "alice", credential: "s3cret" })
      )
      // …and reads back through the same plugin proxy.
      expect(await loadTurnCredential("k-dev")).toEqual({ username: "alice", credential: "s3cret" })
    } finally {
      if (realCap === undefined) delete (window as { Capacitor?: unknown }).Capacitor
      else (window as { Capacitor?: unknown }).Capacitor = realCap
      __setTurnCredentialBackend(null)
    }
  })
})
