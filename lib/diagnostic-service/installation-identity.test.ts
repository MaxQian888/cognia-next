import type { KeyringStore } from "@/lib/credentials/keyring-store"

import {
  exchangeAnonymousGrant,
  installationProofMessage,
  loadOrCreateInstallationIdentity,
  supportsInstallationProof,
} from "./installation-identity"

function memoryKeyring(): KeyringStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    save: (key, value) => {
      entries.set(key, value)
      return Promise.resolve()
    },
    load: (key) => Promise.resolve(entries.get(key) ?? null),
    delete: (key) => {
      entries.delete(key)
      return Promise.resolve()
    },
  }
}

describe("supportsInstallationProof", () => {
  it("probes by generating a key rather than trusting the algorithm table", async () => {
    await expect(supportsInstallationProof()).resolves.toBe(true)
  })

  it("reports false when the engine rejects Ed25519 at generateKey", async () => {
    // Several WebViews list the algorithm and then refuse it. A capability
    // that lies turns into "the service rejected your crash report".
    const subtle = {
      generateKey: () => Promise.reject(new Error("NotSupportedError")),
    } as unknown as SubtleCrypto
    await expect(supportsInstallationProof({ subtle })).resolves.toBe(false)
  })

  it("reports false when there is no WebCrypto at all", async () => {
    const original = globalThis.crypto
    // A WebView old enough to lack `crypto.subtle` entirely: the probe must
    // answer, not throw, because the caller renders a capability line from it.
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true })
    try {
      await expect(supportsInstallationProof()).resolves.toBe(false)
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true })
    }
  })

  it("falls back to the platform when no subtle is injected", async () => {
    // `undefined` means "not injected", not "unavailable" — the deps object is
    // a test seam, and an omitted field must not disable the real one.
    await expect(
      supportsInstallationProof({ subtle: undefined as unknown as SubtleCrypto })
    ).resolves.toBe(true)
  })
})

describe("loadOrCreateInstallationIdentity", () => {
  it("derives the id exactly the way the Rust side does", async () => {
    const keyring = memoryKeyring()
    const identity = await loadOrCreateInstallationIdentity("account-a", { keyring })
    expect(identity).not.toBeNull()
    // `inst_` + the first 16 bytes of SHA-256 over the raw public key, hex.
    // The Rust identity uses the same derivation; a mismatch would produce two
    // installation ids for what the service must see as one shape.
    expect(identity!.installationId).toMatch(/^inst_[0-9a-f]{32}$/)

    const publicKey = Buffer.from(identity!.publicKeyBase64, "base64")
    expect(publicKey).toHaveLength(32)
    const digest = await crypto.subtle.digest("SHA-256", publicKey)
    const expected = Buffer.from(new Uint8Array(digest).slice(0, 16)).toString("hex")
    expect(identity!.installationId).toBe(`inst_${expected}`)
  })

  it("reuses the stored key rather than regenerating an identity", async () => {
    const keyring = memoryKeyring()
    const first = await loadOrCreateInstallationIdentity("account-a", { keyring })
    const second = await loadOrCreateInstallationIdentity("account-a", { keyring })
    // Regenerating would strand every prior submission: only the installation
    // that made one may withdraw or delete it.
    expect(second!.installationId).toBe(first!.installationId)
    expect(keyring.entries.size).toBe(1)
  })

  it("keeps separate identities per local account", async () => {
    const keyring = memoryKeyring()
    const a = await loadOrCreateInstallationIdentity("account-a", { keyring })
    const b = await loadOrCreateInstallationIdentity("account-b", { keyring })
    expect(a!.installationId).not.toBe(b!.installationId)
  })

  it("never puts the private key anywhere but the keyring", async () => {
    const keyring = memoryKeyring()
    await loadOrCreateInstallationIdentity("account-a", { keyring })
    const stored = JSON.parse(keyring.entries.get("account-a")!) as Record<string, string>
    expect(Object.keys(stored).sort()).toEqual(["privateKey", "publicKey"])
    // The store is the OS keychain on both mobile platforms; nothing else in
    // this module writes the key out.
    expect(stored.privateKey.length).toBeGreaterThan(40)
  })

  it("regenerates from an unparsable stored key instead of failing forever", async () => {
    const keyring = memoryKeyring()
    keyring.entries.set("account-a", "{ truncated")
    const identity = await loadOrCreateInstallationIdentity("account-a", { keyring })
    expect(identity).not.toBeNull()
    expect(keyring.entries.get("account-a")).toContain("privateKey")
  })

  it("returns null when the platform cannot do Ed25519", async () => {
    const subtle = {
      generateKey: () => Promise.reject(new Error("NotSupportedError")),
    } as unknown as SubtleCrypto
    await expect(
      loadOrCreateInstallationIdentity("account-a", { keyring: memoryKeyring(), subtle })
    ).resolves.toBeNull()
  })

  it("signs a message the service can verify with the advertised public key", async () => {
    const keyring = memoryKeyring()
    const identity = (await loadOrCreateInstallationIdentity("account-a", { keyring }))!
    const message = installationProofMessage({
      tenantId: "tenant-1",
      projectId: "project-1",
      installationId: identity.installationId,
      nonce: "nonce-value",
      timestamp: 1_700_000_000,
    })
    const signature = Buffer.from(await identity.sign(message), "base64")
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(identity.publicKeyBase64, "base64"),
      { name: "Ed25519" },
      false,
      ["verify"]
    )
    await expect(
      crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, Buffer.from(message))
    ).resolves.toBe(true)
  })
})

describe("installationProofMessage", () => {
  it("is the exact newline-joined string the service reconstructs", () => {
    // Byte-for-byte identical to `build_installation_proof_body` in
    // `crates/cognia-observability/src/diagnostic_submit.rs`. Drift here
    // surfaces server-side as an unexplained 401.
    expect(
      installationProofMessage({
        tenantId: "t",
        projectId: "p",
        installationId: "inst_abc",
        nonce: "n",
        timestamp: 42,
      })
    ).toBe("t\np\ninst_abc\nn\n42")
  })
})

describe("exchangeAnonymousGrant", () => {
  it("sends a fresh nonce and a second-resolution timestamp", async () => {
    const keyring = memoryKeyring()
    const identity = (await loadOrCreateInstallationIdentity("account-a", { keyring }))!
    const bodies: string[] = []
    const fetchImpl = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(JSON.stringify({ grant: "g", role: "uploader", expiresInSeconds: 900 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const options = {
      baseUrl: "https://diag.example.com",
      tenantId: "tenant-1",
      projectId: "project-1",
      identity,
      fetchImpl,
      now: () => 1_700_000_000_123,
    }
    await exchangeAnonymousGrant(options)
    await exchangeAnonymousGrant(options)

    const [first, second] = bodies.map((body) => JSON.parse(body) as Record<string, unknown>)
    // Seconds, not milliseconds: the service's ±5 minute window is in seconds.
    expect(first.timestamp).toBe(1_700_000_000)
    expect(first.installationId).toBe(identity.installationId)
    // A reused nonce is refused as a replay, so each call mints its own.
    expect(first.nonce).not.toBe(second.nonce)
    expect(String(first.nonce)).toHaveLength(48)
  })

  it("surfaces a replayed proof as the service's own code", async () => {
    const keyring = memoryKeyring()
    const identity = (await loadOrCreateInstallationIdentity("account-a", { keyring }))!
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "installation_proof_replayed" } }), {
          status: 409,
        })
    )
    await expect(
      exchangeAnonymousGrant({
        baseUrl: "https://diag.example.com",
        tenantId: "tenant-1",
        projectId: "project-1",
        identity,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: "installation_proof_replayed", status: 409 })
  })
})
