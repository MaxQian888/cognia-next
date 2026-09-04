/**
 * Verification of the signed update catalog.
 *
 * Runs in the renderer, the CLI and the Worker's own tests, so it uses only
 * WebCrypto. Ed25519 is the single accepted algorithm: an unrecognised keytype
 * is a rejection, never a downgrade to "unsigned but probably fine".
 */

import {
  CatalogVerificationError,
  type CatalogRole,
  type CatalogRootPayload,
  type CatalogSnapshotPayload,
  type CatalogTargetsPayload,
  type CatalogTimestampPayload,
  type CatalogTrustState,
  type SignedCatalog,
  type SignedDocument,
} from "./catalog-types"

/** Deterministic serialization the signer and the verifier must agree on. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(",")}}`
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new CatalogVerificationError("malformed", "root", "hex payload is not well formed")
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new CatalogVerificationError("malformed", "root", "WebCrypto is unavailable")
  }
  return c.subtle
}

async function verifyOne(
  publicKeyHex: string,
  signatureHex: string,
  message: Uint8Array
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      "raw",
      hexToBytes(publicKeyHex) as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    )
    return await subtle().verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex) as unknown as BufferSource,
      message as unknown as BufferSource
    )
  } catch {
    return false
  }
}

interface VerifyRoleOptions {
  role: CatalogRole
  doc: SignedDocument<{ _type: string; version: number; expires: string }>
  root: CatalogRootPayload
  now: number
  /** Highest version of this role already trusted, if any. */
  seenVersion?: number
}

/**
 * Check one role document against the trusted root: signature threshold,
 * declared type, expiry, and monotonic version.
 */
export async function verifyRoleDocument(options: VerifyRoleOptions): Promise<void> {
  const { role, doc, root, now, seenVersion } = options
  const payload = doc?.signed
  if (!payload || typeof payload !== "object" || !Array.isArray(doc.signatures)) {
    throw new CatalogVerificationError("malformed", role, `${role} document is malformed`)
  }
  if (payload._type !== role) {
    throw new CatalogVerificationError("role-mismatch", role, `expected _type ${role}`)
  }
  const expires = Date.parse(payload.expires)
  if (Number.isNaN(expires)) {
    throw new CatalogVerificationError("malformed", role, `${role} expiry is unparseable`)
  }
  if (expires <= now) {
    throw new CatalogVerificationError("expired", role, `${role} metadata expired`)
  }
  if (typeof payload.version !== "number" || !Number.isInteger(payload.version)) {
    throw new CatalogVerificationError("malformed", role, `${role} version is not an integer`)
  }
  if (seenVersion !== undefined && payload.version < seenVersion) {
    throw new CatalogVerificationError(
      "rollback",
      role,
      `${role} version ${payload.version} is older than trusted ${seenVersion}`
    )
  }

  const spec = root.roles?.[role]
  if (!spec || !Array.isArray(spec.keyids) || spec.threshold < 1) {
    throw new CatalogVerificationError("malformed", role, `root declares no ${role} role`)
  }
  const revoked = new Set(root.revokedKeyIds ?? [])
  const message = new TextEncoder().encode(canonicalize(payload))
  const counted = new Set<string>()

  for (const signature of doc.signatures) {
    if (!signature || typeof signature.keyid !== "string") continue
    if (counted.has(signature.keyid)) continue
    if (revoked.has(signature.keyid)) {
      throw new CatalogVerificationError("revoked-key", role, `key ${signature.keyid} is revoked`)
    }
    if (!spec.keyids.includes(signature.keyid)) continue
    const key = root.keys?.[signature.keyid]
    if (!key)
      throw new CatalogVerificationError("unknown-key", role, "signature names no known key")
    if (key.keytype !== "ed25519") {
      throw new CatalogVerificationError("malformed", role, `unsupported keytype ${key.keytype}`)
    }
    if (await verifyOne(key.publicKey, signature.sig, message)) counted.add(signature.keyid)
  }

  if (counted.size < spec.threshold) {
    throw new CatalogVerificationError(
      counted.size === 0 ? "signature" : "threshold",
      role,
      `${role} has ${counted.size} valid signatures, needs ${spec.threshold}`
    )
  }
}

export interface VerifiedCatalog {
  targets: CatalogTargetsPayload
  trust: CatalogTrustState
}

/**
 * Verify a full catalog bundle and return the trusted targets payload plus the
 * advanced trust state the caller must persist.
 *
 * Order matters: root first (it names every other key), then timestamp (proves
 * liveness), then snapshot (pins the targets version), then targets itself.
 */
export async function verifySignedCatalog(
  catalog: SignedCatalog,
  trust: CatalogTrustState,
  now: number = Date.now()
): Promise<VerifiedCatalog> {
  if (!catalog?.root || !catalog.timestamp || !catalog.snapshot || !catalog.targets) {
    throw new CatalogVerificationError("malformed", "root", "catalog bundle is incomplete")
  }

  // A new root must be signed by the root we already trust before it replaces it.
  await verifyRoleDocument({
    role: "root",
    doc: catalog.root as SignedDocument<CatalogRootPayload>,
    root: trust.root,
    now,
    seenVersion: trust.seenVersions.root ?? trust.root.version,
  })
  const root = catalog.root.signed

  await verifyRoleDocument({
    role: "timestamp",
    doc: catalog.timestamp as SignedDocument<CatalogTimestampPayload>,
    root,
    now,
    seenVersion: trust.seenVersions.timestamp,
  })
  await verifyRoleDocument({
    role: "snapshot",
    doc: catalog.snapshot as SignedDocument<CatalogSnapshotPayload>,
    root,
    now,
    seenVersion: trust.seenVersions.snapshot,
  })
  if (catalog.timestamp.signed.snapshotVersion !== catalog.snapshot.signed.version) {
    throw new CatalogVerificationError(
      "snapshot-mismatch",
      "snapshot",
      "timestamp points at a different snapshot version"
    )
  }
  await verifyRoleDocument({
    role: "targets",
    doc: catalog.targets as SignedDocument<CatalogTargetsPayload>,
    root,
    now,
    seenVersion: trust.seenVersions.targets,
  })
  if (catalog.snapshot.signed.targetsVersion !== catalog.targets.signed.version) {
    throw new CatalogVerificationError(
      "snapshot-mismatch",
      "targets",
      "snapshot pins a different targets version"
    )
  }

  return {
    targets: catalog.targets.signed,
    trust: {
      root,
      seenVersions: {
        root: root.version,
        timestamp: catalog.timestamp.signed.version,
        snapshot: catalog.snapshot.signed.version,
        targets: catalog.targets.signed.version,
      },
    },
  }
}
