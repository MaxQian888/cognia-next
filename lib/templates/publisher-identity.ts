"use client"

/**
 * The local publisher identity used to SIGN template packages.
 *
 * `ExportTemplatePackageInput.signature` (`lib/templates/package.ts`) has been
 * on the manifest format since the package contract landed, and nothing ever
 * filled it in: every package this app produced was `trust: "unsigned"`, and
 * the four trust levels the Studio renders had exactly one reachable value on
 * the export side. Verification was already implemented (`crypto.subtle`
 * Ed25519 over `templatePackageSignaturePayload(manifest)`, a raw 32-byte
 * public key and a 64-byte signature), so the missing half is a key pair whose
 * private half never leaves the device.
 *
 * ## Where the private key lives
 *
 * `createKeyringStore("template-publisher")` from
 * `lib/credentials/keyring-store.ts`, NOT `lib/keyring/index.ts`. The two are
 * not interchangeable:
 *
 *   - `lib/keyring` routes through Tauri IPC and, off Tauri, falls back to an
 *     AES-GCM blob in IndexedDB whose key comes from a caller-supplied
 *     passphrase. With no passphrase it REFUSES writes and reads null, so a
 *     user signing a package in the browser or on the phone would silently get
 *     an unsigned package back, which is precisely the failure this module
 *     exists to remove.
 *   - `createKeyringStore` is host-neutral by construction: Tauri secret store,
 *     Capacitor SecureStorage (iOS Keychain / Android Keystore), the headless
 *     host's service-scoped store, and the account Browser Vault on the web,
 *     with an explicit `isPersistent()` so a caller can say when a key would
 *     only live for the session.
 *
 * No Dexie table is involved. A signing key is a secret, and the ledger of keys
 * a user TRUSTS (`lib/db/trusted-publishers.ts`) is a different, public thing.
 */

import { sha256Bytes } from "@/lib/ocr/hash"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import type { TemplatePackageSigner } from "./package"

/** Namespace this key occupies in the OS keyring / SecureStorage / vault. */
export const TEMPLATE_PUBLISHER_NAMESPACE = "template-publisher"

/** The single active identity's key id inside that namespace. */
export const TEMPLATE_PUBLISHER_KEY_ID = "active"

/** What the UI may show. Deliberately carries no private material. */
export interface TemplatePublisherIdentity {
  /** Base64 raw 32-byte Ed25519 public key, the manifest's `publicKey`. */
  publicKey: string
  /**
   * SHA-256 hex of the RAW public key bytes.
   *
   * The same derivation the WASM plugin installer uses
   * (`crates/cognia-plugin-runtime/src/wasm/installer.rs` hashes the decoded
   * key), so a template publisher and a plugin publisher are comparable rows in
   * the one `trustedPublishers` ledger rather than two incompatible digests.
   */
  fingerprint: string
  /** Display name written into `signature.publisher`. */
  publisher: string
  createdAt: number
}

/** The persisted record. `privateKey` never leaves this module. */
interface StoredPublisherIdentity extends TemplatePublisherIdentity {
  /** Base64 PKCS#8 Ed25519 private key. */
  privateKey: string
}

export interface PublisherIdentityDeps {
  store?: KeyringStore
  now?: () => number
}

let sharedStore: KeyringStore | undefined

/**
 * The production store, built lazily.
 *
 * Lazily because `createKeyringStore` reaches for `window` through the
 * Capacitor / Browser Vault detection, and this module is imported by suites
 * that run in the node test project.
 */
function resolveStore(deps?: PublisherIdentityDeps): KeyringStore {
  if (deps?.store) return deps.store
  sharedStore ??= createKeyringStore(TEMPLATE_PUBLISHER_NAMESPACE)
  return sharedStore
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle
  if (!api) {
    throw new Error("Template package signing requires the Web Crypto API (crypto.subtle)")
  }
  return api
}

/**
 * A default display name derived from the key itself.
 *
 * There is no account name this module may assume exists (the identity plane is
 * optional, and a template can be authored before anyone signs in), and an
 * empty `publisher` is refused by `validateTemplatePackageManifest`. A short
 * fingerprint prefix is at least verifiable against the full digest the import
 * dialog shows.
 */
function defaultPublisherName(fingerprint: string): string {
  return `cognia:${fingerprint.slice(0, 12)}`
}

function parseStored(raw: string | null): StoredPublisherIdentity | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPublisherIdentity>
    if (
      typeof parsed?.publicKey === "string" &&
      typeof parsed.privateKey === "string" &&
      typeof parsed.fingerprint === "string" &&
      typeof parsed.publisher === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed as StoredPublisherIdentity
    }
  } catch {
    // A corrupt record is treated as absent: the caller either reads null or
    // mints a replacement. Throwing here would brick the export dialog.
  }
  return null
}

function publicView(stored: StoredPublisherIdentity): TemplatePublisherIdentity {
  return {
    publicKey: stored.publicKey,
    fingerprint: stored.fingerprint,
    publisher: stored.publisher,
    createdAt: stored.createdAt,
  }
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return Uint8Array.from(bytes) as unknown as BufferSource
}

async function generate(
  publisher: string | undefined,
  now: () => number
): Promise<StoredPublisherIdentity> {
  const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const rawPublic = new Uint8Array(await subtle().exportKey("raw", pair.publicKey))
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey))
  const fingerprint = await sha256Bytes(rawPublic)
  return {
    publicKey: encodeBase64(rawPublic),
    privateKey: encodeBase64(pkcs8),
    fingerprint,
    publisher: publisher?.trim() || defaultPublisherName(fingerprint),
    createdAt: now(),
  }
}

/**
 * The fingerprint for any base64 Ed25519 public key.
 *
 * Exported because the import dialog has to derive one for a key it did NOT
 * create, to write the `trustedPublishers` row. Same derivation as
 * {@link TemplatePublisherIdentity.fingerprint}, so a template publisher and a
 * plugin publisher land as one row rather than two.
 */
export async function publisherFingerprint(publicKeyBase64: string): Promise<string> {
  return sha256Bytes(decodeBase64(publicKeyBase64))
}

/** Read the active identity, or null when none has been created yet. */
export async function getPublisherIdentity(
  deps?: PublisherIdentityDeps
): Promise<TemplatePublisherIdentity | null> {
  const stored = parseStored(await resolveStore(deps).load(TEMPLATE_PUBLISHER_KEY_ID))
  return stored ? publicView(stored) : null
}

/** Read the active identity, creating one on first use. */
export async function getOrCreatePublisherIdentity(
  options?: { publisher?: string } & PublisherIdentityDeps
): Promise<TemplatePublisherIdentity> {
  const store = resolveStore(options)
  const existing = parseStored(await store.load(TEMPLATE_PUBLISHER_KEY_ID))
  if (existing) return publicView(existing)
  const created = await generate(options?.publisher, options?.now ?? Date.now)
  await store.save(TEMPLATE_PUBLISHER_KEY_ID, JSON.stringify(created))
  return publicView(created)
}

/**
 * Replace the key pair.
 *
 * Rotation is destructive on purpose: packages already signed with the old key
 * keep verifying for anyone who has that key, but this device can no longer
 * produce a signature under it. Nothing here touches the trust ledger. A
 * recipient who trusted the old key still trusts it, and will be asked about
 * the new one the first time they see it.
 */
export async function rotatePublisherIdentity(
  options?: { publisher?: string } & PublisherIdentityDeps
): Promise<TemplatePublisherIdentity> {
  const store = resolveStore(options)
  const previous = parseStored(await store.load(TEMPLATE_PUBLISHER_KEY_ID))
  const created = await generate(
    options?.publisher ?? previous?.publisher,
    options?.now ?? Date.now
  )
  await store.save(TEMPLATE_PUBLISHER_KEY_ID, JSON.stringify(created))
  return publicView(created)
}

/** Whether the active key would survive a restart on this shell. */
export function publisherIdentityIsPersistent(deps?: PublisherIdentityDeps): boolean {
  const store = resolveStore(deps)
  return store.isPersistent?.() ?? false
}

/**
 * Sign canonical manifest bytes with the active key.
 *
 * Throws when no identity exists rather than returning an unsigned package
 * quietly: the caller asked for a signature, and a silently-unsigned export is
 * the exact defect this module was added to remove.
 */
export async function signManifest(
  payload: Uint8Array,
  deps?: PublisherIdentityDeps
): Promise<Uint8Array> {
  const stored = parseStored(await resolveStore(deps).load(TEMPLATE_PUBLISHER_KEY_ID))
  if (!stored) throw new Error("No template publisher identity has been created on this device")
  const key = await subtle().importKey(
    "pkcs8",
    bufferSource(decodeBase64(stored.privateKey)),
    "Ed25519",
    false,
    ["sign"]
  )
  const signature = await subtle().sign("Ed25519", key, bufferSource(payload))
  return new Uint8Array(signature)
}

/**
 * The signer `TemplateService.exportPackage` accepts.
 *
 * Resolves the identity once so the manifest's `publisher` / `publicKey` and
 * the signature that covers them are guaranteed to come from the same key.
 * Building them from two separate reads is how a rotation mid-export would
 * produce a manifest nothing can verify.
 */
export async function createPublisherSigner(
  options?: { publisher?: string } & PublisherIdentityDeps
): Promise<TemplatePackageSigner> {
  const identity = await getOrCreatePublisherIdentity(options)
  return {
    publisher: identity.publisher,
    publicKey: identity.publicKey,
    sign: (payload) => signManifest(payload, options),
  }
}
