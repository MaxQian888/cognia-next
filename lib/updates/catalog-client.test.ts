/** @jest-environment jsdom */
import { DEFAULT_CATALOG_URL, fetchVerifiedCatalog, localStorageTrustStore } from "./catalog-client"
import { canonicalize } from "./catalog-verify"
import type { CatalogTrustState, SignedCatalog } from "./catalog-types"

const FUTURE = "2030-01-01T00:00:00Z"

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function buildSignedCatalog(targetsVersion = 1) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const publicKey = toHex(await crypto.subtle.exportKey("raw", pair.publicKey))
  const sign = async (payload: unknown) => ({
    keyid: "k1",
    sig: toHex(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(canonicalize(payload))
      )
    ),
  })
  const root = {
    _type: "root" as const,
    version: 1,
    expires: FUTURE,
    keys: { k1: { keyid: "k1", keytype: "ed25519" as const, publicKey } },
    roles: {
      root: { keyids: ["k1"], threshold: 1 },
      targets: { keyids: ["k1"], threshold: 1 },
      snapshot: { keyids: ["k1"], threshold: 1 },
      timestamp: { keyids: ["k1"], threshold: 1 },
    },
  }
  const targets = {
    _type: "targets" as const,
    version: targetsVersion,
    expires: FUTURE,
    entries: [
      {
        assetId: "app",
        kind: "desktop" as const,
        executor: "tauri" as const,
        version: "2.0.0",
        channel: "stable" as const,
        criticality: "routine" as const,
        releasedAt: FUTURE,
      },
    ],
  }
  const snapshot = {
    _type: "snapshot" as const,
    version: targetsVersion,
    expires: FUTURE,
    targetsVersion,
  }
  const timestamp = {
    _type: "timestamp" as const,
    version: targetsVersion,
    expires: FUTURE,
    snapshotVersion: targetsVersion,
  }
  const catalog: SignedCatalog = {
    root: { signed: root, signatures: [await sign(root)] },
    targets: { signed: targets, signatures: [await sign(targets)] },
    snapshot: { signed: snapshot, signatures: [await sign(snapshot)] },
    timestamp: { signed: timestamp, signatures: [await sign(timestamp)] },
  }
  return { catalog, root }
}

function memoryStore(initial: CatalogTrustState | null = null) {
  let state = initial
  return {
    read: () => state,
    write: (next: CatalogTrustState) => {
      state = next
    },
    current: () => state,
  }
}

const ORIGINAL_ROOT = process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT
  else process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = ORIGINAL_ROOT
})

describe("fetchVerifiedCatalog", () => {
  it("returns null when the build ships no trust root", async () => {
    delete process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT
    const fetchImpl = jest.fn()
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("verifies and returns the entries", async () => {
    const { catalog, root } = await buildSignedCatalog(3)
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    const store = memoryStore()
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 42 },
      {
        trustStore: store,
        fetchImpl: (async () =>
          new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch,
      }
    )
    expect(result?.entries).toHaveLength(1)
    expect(store.current()?.seenVersions.targets).toBe(3)
  })

  it("sends only the cohort bucket, never an identity", async () => {
    const { catalog, root } = await buildSignedCatalog()
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    let seen = ""
    await fetchVerifiedCatalog(
      { channel: "beta", rolloutBucket: 4242 },
      {
        trustStore: memoryStore(),
        platform: "macos",
        appVersion: "1.2.3",
        fetchImpl: (async (url: string) => {
          seen = String(url)
          return new Response(JSON.stringify(catalog), { status: 200 })
        }) as unknown as typeof fetch,
      }
    )
    const parsed = new URL(seen)
    expect(parsed.origin).toBe(new URL(DEFAULT_CATALOG_URL).origin)
    expect(parsed.searchParams.get("bucket")).toBe("4242")
    expect(parsed.searchParams.get("channel")).toBe("beta")
    expect([...parsed.searchParams.keys()].sort()).toEqual([
      "appVersion",
      "bucket",
      "channel",
      "platform",
    ])
  })

  it("treats 204 as an empty catalog, not a failure", async () => {
    const { root } = await buildSignedCatalog()
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      {
        trustStore: memoryStore(),
        fetchImpl: (async () => new Response("", { status: 204 })) as unknown as typeof fetch,
      }
    )
    expect(result?.entries).toEqual([])
  })

  it("surfaces Retry-After so the coordinator can back off", async () => {
    const { root } = await buildSignedCatalog()
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      {
        trustStore: memoryStore(),
        now: () => 0,
        fetchImpl: (async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "120" },
          })) as unknown as typeof fetch,
      }
    )
    expect(result?.retryAfterMs).toBe(120_000)
    expect(result?.entries).toEqual([])
  })

  it("returns null rather than trusting a bundle that fails verification", async () => {
    const { catalog, root } = await buildSignedCatalog()
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    catalog.targets.signed.entries[0].version = "9.9.9"
    const errors: unknown[] = []
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      {
        trustStore: memoryStore(),
        onError: (e) => errors.push(e),
        fetchImpl: (async () =>
          new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch,
      }
    )
    expect(result).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it("refuses a stored root older than the one the build ships", async () => {
    const { catalog, root } = await buildSignedCatalog(2)
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    const stale = memoryStore({
      root: { ...root, version: 0, keys: {}, roles: root.roles },
      seenVersions: { root: 0 },
    })
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      {
        trustStore: stale,
        fetchImpl: (async () =>
          new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch,
      }
    )
    expect(result?.entries).toHaveLength(1)
  })

  it("returns null when the network throws", async () => {
    const { root } = await buildSignedCatalog()
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(root)
    const result = await fetchVerifiedCatalog(
      { channel: "stable", rolloutBucket: 0 },
      {
        trustStore: memoryStore(),
        fetchImpl: (async () => {
          throw new Error("offline")
        }) as unknown as typeof fetch,
      }
    )
    expect(result).toBeNull()
  })
})

describe("localStorageTrustStore", () => {
  it("round-trips the trust state", async () => {
    const { root } = await buildSignedCatalog()
    const store = localStorageTrustStore()
    store.write({ root, seenVersions: { root: 1, targets: 7 } })
    expect(store.read()?.seenVersions.targets).toBe(7)
  })

  it("returns null when nothing is stored", () => {
    localStorage.clear()
    expect(localStorageTrustStore().read()).toBeNull()
  })

  it("returns null on corrupted storage rather than throwing", () => {
    localStorage.setItem("cognia.update.trust.v1", "{not json")
    expect(localStorageTrustStore().read()).toBeNull()
  })
})
