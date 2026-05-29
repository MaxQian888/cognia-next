"use client"

/**
 * Persistent storage abstraction for the desktop server credentials the
 * mobile / web companion needs (`baseUrl`, `deviceJwt`, `deviceId`,
 * `serverVersion`).
 *
 * Two backends:
 *   - {@link LocalStorageCompanionStorage} — `window.localStorage`. Used by
 *     the web build and by jsdom-based unit tests.
 *   - {@link SecureStorageCompanionStorage} — `capacitor-secure-storage-plugin`,
 *     which routes to iOS Keychain / Android Keystore. Used in Capacitor
 *     mobile builds. The plugin is loaded via dynamic `import()` so the
 *     web bundle never pulls native code that wouldn't run there anyway.
 *
 * The selection is one-way: pick a backend at module init via
 * {@link pickCompanionStorage} and reuse a single instance for the
 * lifetime of the app.
 *
 * Async-everywhere is intentional. Capacitor's secure-storage plugin only
 * exposes async methods, and forcing the same shape on the web backend
 * keeps callers from branching on platform.
 */

import { makeDefaultLoader } from "@/lib/capacitor/_shared"

export interface CompanionConfig {
  /** e.g. "https://192.168.1.42:7890" */
  baseUrl: string
  /** Long-lived JWT returned by `POST /api/v1/auth/pair`. */
  deviceJwt: string
  /** Stable device identifier; namespace for idempotency keys + log lines. */
  deviceId: string
  /** Server semver, captured at pair time. Diagnostics only. */
  serverVersion: string
  /**
   * SHA-256 fingerprint (lower-case hex) of the desktop server's TLS
   * SubjectPublicKeyInfo at pair time. The transport layer pins this and
   * refuses to talk to a peer whose presented cert doesn't match. Wave
   * 1.4. Optional for backwards-compat with rows paired before TLS
   * rolled out.
   */
  serverFingerprint?: string
  /**
   * ADR-0021 — public room id used by the WebRTC signaling service to route
   * SDP/ICE messages between this client and its desktop server. UUIDv4
   * minted by the desktop pair handler. Absence disables the WebRTC
   * transport tier on this client.
   */
  rendezvousId?: string
  /**
   * ADR-0021 — 32-byte HMAC key (URL-safe base64, unpadded — 43 chars)
   * shared with the desktop server, used to sign signaling envelopes so the
   * public rendezvous service can never impersonate either side. Treated as
   * sensitive: persisted alongside `deviceJwt` in the Capacitor secure
   * storage entry on iOS Keychain / Android Keystore.
   */
  rendezvousSecret?: string
}

export interface CompanionConfigStorage {
  load(): Promise<CompanionConfig | null>
  save(config: CompanionConfig): Promise<void>
  clear(): Promise<void>
}

const CONFIG_KEY = "cognia.companion.config.v1"

// ---------------------------------------------------------------------------
// LocalStorage backend (web + tests)
// ---------------------------------------------------------------------------

export class LocalStorageCompanionStorage implements CompanionConfigStorage {
  async load(): Promise<CompanionConfig | null> {
    if (typeof window === "undefined") return null
    try {
      const raw = window.localStorage.getItem(CONFIG_KEY)
      if (!raw) return null
      return JSON.parse(raw) as CompanionConfig
    } catch {
      return null
    }
  }

  async save(config: CompanionConfig): Promise<void> {
    if (typeof window === "undefined") return
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  }

  async clear(): Promise<void> {
    if (typeof window === "undefined") return
    window.localStorage.removeItem(CONFIG_KEY)
  }
}

// ---------------------------------------------------------------------------
// SecureStorage backend (Capacitor)
// ---------------------------------------------------------------------------

// Minimal slice of capacitor-secure-storage-plugin's API surface. Avoids a
// hard import at module load so the web bundle does not try to resolve a
// native package that has no web fallback.
interface SecureStoragePluginShape {
  set(opts: { key: string; value: string }): Promise<{ value: boolean }>
  get(opts: { key: string }): Promise<{ value: string }>
  remove(opts: { key: string }): Promise<{ value: boolean }>
}

type SecureStoragePluginLoader = () => Promise<SecureStoragePluginShape>

// Resolve the SecureStorage plugin the SAME way every other native wrapper
// does — via `lib/capacitor/_shared.ts:makeDefaultLoader`, which reads the
// proxy `registerNativePlugins()` populates onto `window.Capacitor.Plugins`
// at mobile boot FIRST and only then falls back to a `webpackIgnore`'d dynamic
// import. The bare `import("capacitor-secure-storage-plugin")` never resolves
// inside the static-export WebView (the npm package isn't bundled and there's
// no node_modules), so the previous import-only loader made `save()` THROW on
// device → the pairing key could never persist. The package-name literal is
// kept so the loader still works if the global proxy is somehow absent.
const defaultSecureStoragePluginLoader: SecureStoragePluginLoader =
  makeDefaultLoader<SecureStoragePluginShape>(
    "capacitor-secure-storage-plugin",
    "SecureStoragePlugin"
  )

export class SecureStorageCompanionStorage implements CompanionConfigStorage {
  private readonly loader: SecureStoragePluginLoader

  constructor(loader: SecureStoragePluginLoader = defaultSecureStoragePluginLoader) {
    this.loader = loader
  }

  async load(): Promise<CompanionConfig | null> {
    try {
      const plugin = await this.loader()
      const { value } = await plugin.get({ key: CONFIG_KEY })
      if (!value) return null
      return JSON.parse(value) as CompanionConfig
    } catch {
      // get() throws when the key is absent — treat as "not paired yet".
      return null
    }
  }

  async save(config: CompanionConfig): Promise<void> {
    const plugin = await this.loader()
    await plugin.set({ key: CONFIG_KEY, value: JSON.stringify(config) })
  }

  async clear(): Promise<void> {
    try {
      const plugin = await this.loader()
      await plugin.remove({ key: CONFIG_KEY })
    } catch {
      // remove() throws when the key is already gone — idempotent.
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function isCapacitor(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform === "function" &&
    (
      window as unknown as { Capacitor: { isNativePlatform: () => boolean } }
    ).Capacitor.isNativePlatform() === true
  )
}

export function pickCompanionStorage(): CompanionConfigStorage {
  return isCapacitor() ? new SecureStorageCompanionStorage() : new LocalStorageCompanionStorage()
}

// Module-scope singleton — picked once at first import.
let storageInstance: CompanionConfigStorage | null = null

export function companionStorage(): CompanionConfigStorage {
  if (storageInstance === null) {
    storageInstance = pickCompanionStorage()
  }
  return storageInstance
}

/**
 * Override the active storage instance. Test-only — production code should
 * never call this. The transport caches the resolved config in memory, so
 * swapping storage at runtime in production would leave the cache stale.
 */
export function __setCompanionStorageForTests(next: CompanionConfigStorage | null): void {
  storageInstance = next
}
