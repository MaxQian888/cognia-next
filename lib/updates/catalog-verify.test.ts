import {
  CatalogVerificationError,
  type CatalogTrustState,
  type SignedCatalog,
} from "./catalog-types"
import { canonicalize, hexToBytes, verifySignedCatalog } from "./catalog-verify"

const NOW = Date.parse("2026-01-01T00:00:00Z")
const FUTURE = "2027-01-01T00:00:00Z"
const PAST = "2025-01-01T00:00:00Z"

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface Signer {
  keyid: string
  publicKey: string
  sign(payload: unknown): Promise<{ keyid: string; sig: string }>
}

async function makeSigner(keyid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const publicKey = toHex(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    keyid,
    publicKey,
    async sign(payload) {
      const message = new TextEncoder().encode(canonicalize(payload))
      const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, message)
      return { keyid, sig: toHex(sig) }
    },
  }
}

async function buildCatalog(
  signer: Signer,
  overrides: {
    rootVersion?: number
    targetsVersion?: number
    snapshotVersion?: number
    timestampVersion?: number
    snapshotPointsAt?: number
    timestampPointsAt?: number
    targetsExpires?: string
    threshold?: number
  } = {}
): Promise<SignedCatalog> {
  const rootPayload = {
    _type: "root" as const,
    version: overrides.rootVersion ?? 1,
    expires: FUTURE,
    keys: {
      [signer.keyid]: {
        keyid: signer.keyid,
        keytype: "ed25519" as const,
        publicKey: signer.publicKey,
      },
    },
    roles: {
      root: { keyids: [signer.keyid], threshold: overrides.threshold ?? 1 },
      targets: { keyids: [signer.keyid], threshold: 1 },
      snapshot: { keyids: [signer.keyid], threshold: 1 },
      timestamp: { keyids: [signer.keyid], threshold: 1 },
    },
  }
  const targetsVersion = overrides.targetsVersion ?? 5
  const snapshotVersion = overrides.snapshotVersion ?? 5
  const timestampVersion = overrides.timestampVersion ?? 5
  const targetsPayload = {
    _type: "targets" as const,
    version: targetsVersion,
    expires: overrides.targetsExpires ?? FUTURE,
    entries: [
      {
        assetId: "app",
        kind: "desktop" as const,
        executor: "tauri" as const,
        version: "2.0.0",
        channel: "stable" as const,
        criticality: "routine" as const,
        releasedAt: "2026-01-01T00:00:00Z",
      },
    ],
  }
  const snapshotPayload = {
    _type: "snapshot" as const,
    version: snapshotVersion,
    expires: FUTURE,
    targetsVersion: overrides.snapshotPointsAt ?? targetsVersion,
  }
  const timestampPayload = {
    _type: "timestamp" as const,
    version: timestampVersion,
    expires: FUTURE,
    snapshotVersion: overrides.timestampPointsAt ?? snapshotVersion,
  }
  return {
    root: { signed: rootPayload, signatures: [await signer.sign(rootPayload)] },
    targets: { signed: targetsPayload, signatures: [await signer.sign(targetsPayload)] },
    snapshot: { signed: snapshotPayload, signatures: [await signer.sign(snapshotPayload)] },
    timestamp: { signed: timestampPayload, signatures: [await signer.sign(timestampPayload)] },
  }
}

function trustFrom(catalog: SignedCatalog): CatalogTrustState {
  return { root: catalog.root.signed, seenVersions: { root: catalog.root.signed.version } }
}

describe("canonicalize", () => {
  it("sorts keys so the signer and the verifier agree", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it("drops undefined rather than emitting it", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]")
  })
})

describe("hexToBytes", () => {
  it("rejects malformed hex instead of decoding garbage", () => {
    expect(() => hexToBytes("zz")).toThrow(CatalogVerificationError)
    expect(() => hexToBytes("abc")).toThrow(CatalogVerificationError)
  })
})

describe("verifySignedCatalog", () => {
  let signer: Signer

  beforeAll(async () => {
    signer = await makeSigner("key-1")
  })

  it("accepts a well-formed bundle and advances the high-water mark", async () => {
    const catalog = await buildCatalog(signer)
    const result = await verifySignedCatalog(catalog, trustFrom(catalog), NOW)
    expect(result.targets.entries).toHaveLength(1)
    expect(result.trust.seenVersions.targets).toBe(5)
  })

  it("refuses a tampered targets payload", async () => {
    const catalog = await buildCatalog(signer)
    catalog.targets.signed.entries[0].version = "9.9.9"
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "signature",
      role: "targets",
    })
  })

  it("refuses expired metadata", async () => {
    const catalog = await buildCatalog(signer, { targetsExpires: PAST })
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "expired",
    })
  })

  it("refuses a replayed older targets version", async () => {
    const catalog = await buildCatalog(signer, { targetsVersion: 4, snapshotPointsAt: 4 })
    const trust = { ...trustFrom(catalog), seenVersions: { root: 1, targets: 9 } }
    await expect(verifySignedCatalog(catalog, trust, NOW)).rejects.toMatchObject({
      reason: "rollback",
      role: "targets",
    })
  })

  it("refuses a revoked key even while it is still listed", async () => {
    const catalog = await buildCatalog(signer)
    const trust = trustFrom(catalog)
    trust.root = { ...trust.root, revokedKeyIds: [signer.keyid] }
    await expect(verifySignedCatalog(catalog, trust, NOW)).rejects.toMatchObject({
      reason: "revoked-key",
    })
  })

  it("refuses a threshold it cannot meet", async () => {
    const catalog = await buildCatalog(signer, { threshold: 2 })
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "threshold",
      role: "root",
    })
  })

  it("refuses a signature from a key the root does not know", async () => {
    const attacker = await makeSigner("key-1")
    const catalog = await buildCatalog(signer)
    catalog.targets.signatures = [await attacker.sign(catalog.targets.signed)]
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "signature",
      role: "targets",
    })
  })

  it("refuses a snapshot that pins a different targets version", async () => {
    const catalog = await buildCatalog(signer, { snapshotPointsAt: 4 })
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "snapshot-mismatch",
      role: "targets",
    })
  })

  it("refuses a timestamp that points at a different snapshot", async () => {
    const catalog = await buildCatalog(signer, { timestampPointsAt: 3 })
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "snapshot-mismatch",
      role: "snapshot",
    })
  })

  it("refuses an incomplete bundle", async () => {
    await expect(
      verifySignedCatalog({} as SignedCatalog, { root: {} as never, seenVersions: {} }, NOW)
    ).rejects.toMatchObject({ reason: "malformed" })
  })

  it("refuses a root document whose declared type is wrong", async () => {
    const catalog = await buildCatalog(signer)
    ;(catalog.root.signed as { _type: string })._type = "targets"
    await expect(verifySignedCatalog(catalog, trustFrom(catalog), NOW)).rejects.toMatchObject({
      reason: "role-mismatch",
    })
  })
})
