"use client"

/**
 * Storage backends for the credential book.
 *
 * Two stores, split by sensitivity rather than by platform:
 *
 * - {@link HostRecordStore} holds the public records plus the active pointer.
 *   Plain storage is fine and *wanted*: Settings must be able to list every
 *   paired host while the Vault is locked, and a locked Vault must not look
 *   like "no hosts paired".
 * - {@link HostCredentialStore} holds device and signaling private keys.
 *   Browser: the PBKDF2/AES-GCM Vault, so a locked Vault genuinely cannot
 *   produce a token. Capacitor: the platform keystore.
 *
 * That split is why `list()` never returns secrets and why every credential
 * read is a separate, failable call.
 */
import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { getActiveBrowserVault, type EncryptedVaultSecret } from "@/lib/runtime/browser-vault"

import {
  hostRecordKey,
  type CompanionHostCredential,
  type CompanionHostKey,
  type CompanionHostRecord,
} from "./types"

export const HOST_BOOK_KEY = "cognia.companion.hosts.v2"
export const ACTIVE_HOST_KEY = "cognia.companion.hosts.active.v2"
const LEGACY_HOST_BOOK_KEY = "cognia.companion.hosts.v1"
const LEGACY_ACTIVE_HOST_KEY = "cognia.companion.hosts.active.v1"

/** Envelope format for the persisted record book. */
export interface HostBookEnvelope {
  version: 2
  hosts: Record<string, CompanionHostRecord>
  /** Active host storage key, per account namespace. */
  active: Record<string, string>
}

export function emptyHostBook(): HostBookEnvelope {
  return { version: 2, hosts: {}, active: {} }
}

export interface HostRecordStore {
  read(): Promise<HostBookEnvelope>
  write(book: HostBookEnvelope): Promise<void>
}

export interface HostCredentialStore {
  load(key: CompanionHostKey): Promise<CompanionHostCredential | null>
  save(key: CompanionHostKey, credential: CompanionHostCredential): Promise<void>
  remove(key: CompanionHostKey): Promise<void>
}

/**
 * Parse a persisted book, tolerating absence but not corruption.
 *
 * A malformed book is thrown rather than silently reset: silently resetting it
 * would look exactly like "you were never paired", and the user would re-pair
 * over a book that might still hold a recoverable host.
 */
export function parseHostBook(raw: string | null): HostBookEnvelope {
  if (!raw) return emptyHostBook()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Companion host book is not valid JSON.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Companion host book is not an object.")
  }
  const root = parsed as Record<string, unknown>
  if (root.version !== 2) {
    throw new Error(`Companion host book version ${String(root.version)} is not supported.`)
  }
  if (!root.hosts || typeof root.hosts !== "object" || Array.isArray(root.hosts)) {
    throw new Error("Companion host book has no host map.")
  }
  const active =
    root.active && typeof root.active === "object" && !Array.isArray(root.active)
      ? (root.active as Record<string, string>)
      : {}
  return {
    version: 2,
    hosts: root.hosts as Record<string, CompanionHostRecord>,
    active,
  }
}

// ── records ─────────────────────────────────────────────────────────────────

/** `window.localStorage` record store — web build and jsdom tests. */
export class LocalStorageHostRecordStore implements HostRecordStore {
  async read(): Promise<HostBookEnvelope> {
    if (typeof window === "undefined") return emptyHostBook()
    window.localStorage.removeItem(LEGACY_HOST_BOOK_KEY)
    window.localStorage.removeItem(LEGACY_ACTIVE_HOST_KEY)
    return parseHostBook(window.localStorage.getItem(HOST_BOOK_KEY))
  }

  async write(book: HostBookEnvelope): Promise<void> {
    if (typeof window === "undefined") return
    if (Object.keys(book.hosts).length === 0) {
      window.localStorage.removeItem(HOST_BOOK_KEY)
      window.localStorage.removeItem(ACTIVE_HOST_KEY)
      return
    }
    window.localStorage.setItem(HOST_BOOK_KEY, JSON.stringify(book))
  }
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * The Browser Vault is not unlocked, so no companion credential can be read or
 * written on this web client.
 *
 * A distinct type rather than a bare `Error` because the pairing flow has to
 * tell this apart from a storage *failure*: the device really did register with
 * the Host, and the one-shot invitation really is spent, so "pair again" is the
 * wrong advice — the user has to unlock their local account first. Matching on
 * the message text across that module boundary is exactly the kind of coupling
 * that rots, so the boundary carries a type instead.
 */
export class BrowserVaultLockedError extends Error {
  constructor(message = "Browser Vault must be unlocked to reach companion credentials.") {
    super(message)
    this.name = "BrowserVaultLockedError"
  }
}

interface VaultSecretAdapter {
  accountId: string
  storeSecret(name: string, value: string): Promise<void>
  loadSecret(name: string): Promise<string | null>
  deleteSecret(name: string): Promise<void>
  encryptSecret?(name: string, value: string): Promise<EncryptedVaultSecret>
}

function deviceKeySecretName(key: CompanionHostKey): string {
  return `companion-host:${hostRecordKey(key)}:device-private-jwk`
}

function legacyJwtSecretName(key: CompanionHostKey): string {
  return `companion-host:${hostRecordKey(key)}:device-jwt`
}

function signingSecretName(key: CompanionHostKey): string {
  return `companion-host:${hostRecordKey(key)}:signaling-private-jwk`
}

/**
 * Browser Vault credential store.
 *
 * Reads and writes go through the *currently unlocked* Vault, and a key whose
 * `accountNamespace` is not that Vault's account is refused outright — one
 * account must never be able to mint a request with another account's token,
 * even by handing the book a foreign key.
 */
export class VaultHostCredentialStore implements HostCredentialStore {
  constructor(
    private readonly vaultProvider: () => VaultSecretAdapter | null = getActiveBrowserVault
  ) {}

  async load(key: CompanionHostKey): Promise<CompanionHostCredential | null> {
    const vault = this.requireVault(key)
    const serializedDeviceKey = await vault.loadSecret(deviceKeySecretName(key))
    if (!serializedDeviceKey) return null
    const credential: CompanionHostCredential = {
      devicePrivateKeyJwk: JSON.parse(serializedDeviceKey) as JsonWebKey,
    }
    const jwk = await vault.loadSecret(signingSecretName(key))
    if (jwk) credential.signalingPrivateKeyJwk = JSON.parse(jwk) as JsonWebKey
    return credential
  }

  async save(key: CompanionHostKey, credential: CompanionHostCredential): Promise<void> {
    const vault = this.requireVault(key)
    await vault.storeSecret(
      deviceKeySecretName(key),
      JSON.stringify(credential.devicePrivateKeyJwk)
    )
    await vault.deleteSecret(legacyJwtSecretName(key))
    if (credential.signalingPrivateKeyJwk) {
      await vault.storeSecret(
        signingSecretName(key),
        JSON.stringify(credential.signalingPrivateKeyJwk)
      )
    } else {
      await vault.deleteSecret(signingSecretName(key))
    }
  }

  async remove(key: CompanionHostKey): Promise<void> {
    const vault = this.requireVault(key)
    await Promise.all([
      vault.deleteSecret(deviceKeySecretName(key)),
      vault.deleteSecret(legacyJwtSecretName(key)),
      vault.deleteSecret(signingSecretName(key)),
    ])
  }

  private requireVault(key: CompanionHostKey): VaultSecretAdapter {
    const vault = this.vaultProvider()
    if (!vault) throw new BrowserVaultLockedError()
    if (vault.accountId !== key.accountNamespace) {
      throw new Error(
        `Companion credential for account ${key.accountNamespace} cannot be reached from the ${vault.accountId} Vault.`
      )
    }
    return vault
  }
}

// ── Capacitor secure storage ────────────────────────────────────────────────

interface SecureStoragePluginShape {
  set(opts: { key: string; value: string }): Promise<{ value: boolean }>
  get(opts: { key: string }): Promise<{ value: string }>
  remove(opts: { key: string }): Promise<{ value: boolean }>
}

export type SecureStorageLoader = () => Promise<SecureStoragePluginShape>

/**
 * Resolve the plugin the same way every other native wrapper does — via the
 * `window.Capacitor.Plugins` proxy first, falling back to a dynamic import.
 * A bare `import()` never resolves inside the static-export WebView.
 */
const defaultSecureStorageLoader: SecureStorageLoader = makeDefaultLoader<SecureStoragePluginShape>(
  "capacitor-secure-storage-plugin",
  "SecureStoragePlugin"
)

/** Native keystore credential store — iOS Keychain / Android Keystore. */
export class SecureStorageHostCredentialStore implements HostCredentialStore {
  constructor(private readonly loader: SecureStorageLoader = defaultSecureStorageLoader) {}

  async load(key: CompanionHostKey): Promise<CompanionHostCredential | null> {
    try {
      const plugin = await this.loader()
      const { value } = await plugin.get({ key: deviceKeySecretName(key) })
      if (!value) return null
      const credential: CompanionHostCredential = {
        devicePrivateKeyJwk: JSON.parse(value) as JsonWebKey,
      }
      try {
        const jwk = await plugin.get({ key: signingSecretName(key) })
        if (jwk.value) credential.signalingPrivateKeyJwk = JSON.parse(jwk.value) as JsonWebKey
      } catch {
        // The signing key is optional — a host with no WebRTC tier has none.
      }
      return credential
    } catch {
      // `get()` throws when the key is absent: not paired to this host.
      return null
    }
  }

  async save(key: CompanionHostKey, credential: CompanionHostCredential): Promise<void> {
    const plugin = await this.loader()
    await plugin.set({
      key: deviceKeySecretName(key),
      value: JSON.stringify(credential.devicePrivateKeyJwk),
    })
    await plugin.remove({ key: legacyJwtSecretName(key) }).catch(() => undefined)
    if (credential.signalingPrivateKeyJwk) {
      await plugin.set({
        key: signingSecretName(key),
        value: JSON.stringify(credential.signalingPrivateKeyJwk),
      })
    } else {
      await plugin.remove({ key: signingSecretName(key) }).catch(() => undefined)
    }
  }

  async remove(key: CompanionHostKey): Promise<void> {
    const plugin = await this.loader()
    await Promise.all([
      plugin.remove({ key: deviceKeySecretName(key) }).catch(() => undefined),
      plugin.remove({ key: legacyJwtSecretName(key) }).catch(() => undefined),
      plugin.remove({ key: signingSecretName(key) }).catch(() => undefined),
    ])
  }
}

/**
 * Capacitor record store.
 *
 * Records are public, but the mobile shell has no `localStorage` guarantee
 * across OS upgrades, so the book rides in the same secure storage as the
 * credentials — under a distinct key, and still without any secret in it.
 */
export class SecureStorageHostRecordStore implements HostRecordStore {
  constructor(private readonly loader: SecureStorageLoader = defaultSecureStorageLoader) {}

  async read(): Promise<HostBookEnvelope> {
    try {
      const plugin = await this.loader()
      await Promise.all([
        plugin.remove({ key: LEGACY_HOST_BOOK_KEY }).catch(() => undefined),
        plugin.remove({ key: LEGACY_ACTIVE_HOST_KEY }).catch(() => undefined),
      ])
      const { value } = await plugin.get({ key: HOST_BOOK_KEY })
      return parseHostBook(value || null)
    } catch (error) {
      // A parse failure is real corruption and must surface; a missing key is
      // simply "never paired".
      if (error instanceof Error && error.message.startsWith("Companion host book")) throw error
      return emptyHostBook()
    }
  }

  async write(book: HostBookEnvelope): Promise<void> {
    const plugin = await this.loader()
    if (Object.keys(book.hosts).length === 0) {
      await plugin.remove({ key: HOST_BOOK_KEY }).catch(() => undefined)
      return
    }
    await plugin.set({ key: HOST_BOOK_KEY, value: JSON.stringify(book) })
  }
}
