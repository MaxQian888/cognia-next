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
import { isCapacitor } from "@/lib/platform/detect"
import { importV2SigningPrivateKey, type RoomDescriptorV2 } from "@/lib/signaling/v2-crypto"

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
  /** Public, self-certifying signaling v2 room descriptor. */
  signalingRoomDescriptor?: RoomDescriptorV2
  /**
   * Mobile role ECDSA private key. Capacitor persists this JWK inside native
   * secure storage; the web backend moves it into IndexedDB as a
   * non-extractable CryptoKey before writing public config to localStorage.
   */
  signalingPrivateKeyJwk?: JsonWebKey
  /** Runtime-only non-extractable key loaded by the web identity store. */
  signalingPrivateKey?: CryptoKey
  /**
   * ADR-0059 C4/F3 — local account the pairing was minted for. Multi-account
   * cloud servers route by it; absent on rows paired before it shipped.
   */
  accountId?: string
  /**
   * ADR-0021 channel inventory — the desktop's cloudflared tunnel URL, as
   * last reported by the `companion_endpoints` RPC.
   *
   * The QR pair payload carries exactly ONE `baseUrl`, so a device paired on
   * the LAN would otherwise never learn that its desktop is also reachable
   * from the internet: leaving the network stranded it on the WebRTC tier
   * alone, and a client with WebRTC disabled (or behind a symmetric NAT with
   * no TURN) had no route home at all. Refreshed on every successful connect
   * by `lib/connectivity/endpoint-refresh.ts` and consumed as a failover
   * candidate by the mobile signaling controller. Absent when the desktop is
   * running no tunnel.
   */
  tunnelBaseUrl?: string
  /**
   * ADR-0021 channel inventory — the desktop's `https://<lan-ip>:<port>`
   * address, as last reported by `companion_endpoints`. The mirror of
   * {@link tunnelBaseUrl} for the opposite transition: a device paired over
   * the tunnel learns where to look on the LAN. Absent when the desktop is
   * loopback-bound or has no routable interface.
   */
  lanBaseUrl?: string
}

export interface CompanionConfigStorage {
  load(): Promise<CompanionConfig | null>
  save(config: CompanionConfig): Promise<void>
  clear(): Promise<void>
}

const CONFIG_KEY = "cognia.companion.config.v1"
const SIGNALING_KEY_DB = "cognia-signaling-identity-v2"
const SIGNALING_KEY_STORE = "keys"

interface BrowserSignalingKeyStore {
  save(deviceId: string, jwk: JsonWebKey): Promise<CryptoKey>
  load(deviceId: string): Promise<CryptoKey | null>
  clear(deviceId: string): Promise<void>
}

class IndexedDbSignalingKeyStore implements BrowserSignalingKeyStore {
  async save(deviceId: string, jwk: JsonWebKey): Promise<CryptoKey> {
    const key = await importV2SigningPrivateKey(jwk)
    const database = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SIGNALING_KEY_STORE, "readwrite")
      transaction.objectStore(SIGNALING_KEY_STORE).put(key, deviceId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
    return key
  }

  async load(deviceId: string): Promise<CryptoKey | null> {
    const database = await this.open()
    const key = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = database
        .transaction(SIGNALING_KEY_STORE, "readonly")
        .objectStore(SIGNALING_KEY_STORE)
        .get(deviceId)
      request.onsuccess = () => resolve(request.result as CryptoKey | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return key ?? null
  }

  async clear(deviceId: string): Promise<void> {
    const database = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SIGNALING_KEY_STORE, "readwrite")
      transaction.objectStore(SIGNALING_KEY_STORE).delete(deviceId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SIGNALING_KEY_DB, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SIGNALING_KEY_STORE)) {
          request.result.createObjectStore(SIGNALING_KEY_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
}

// ---------------------------------------------------------------------------
// LocalStorage backend (web + tests)
// ---------------------------------------------------------------------------

export class LocalStorageCompanionStorage implements CompanionConfigStorage {
  constructor(
    private readonly signalingKeys: BrowserSignalingKeyStore = new IndexedDbSignalingKeyStore()
  ) {}

  async load(): Promise<CompanionConfig | null> {
    if (typeof window === "undefined") return null
    try {
      const raw = window.localStorage.getItem(CONFIG_KEY)
      if (!raw) return null
      const config = JSON.parse(raw) as CompanionConfig
      if (config.signalingRoomDescriptor) {
        const key = await this.signalingKeys.load(config.deviceId)
        if (key) config.signalingPrivateKey = key
      }
      return config
    } catch {
      return null
    }
  }

  async save(config: CompanionConfig): Promise<void> {
    if (typeof window === "undefined") return
    const publicConfig = { ...config }
    if (config.signalingPrivateKeyJwk) {
      publicConfig.signalingPrivateKey = await this.signalingKeys.save(
        config.deviceId,
        config.signalingPrivateKeyJwk
      )
    }
    delete publicConfig.signalingPrivateKey
    delete publicConfig.signalingPrivateKeyJwk
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(publicConfig))
  }

  async clear(): Promise<void> {
    if (typeof window === "undefined") return
    const existing = await this.load()
    if (existing?.signalingRoomDescriptor) {
      await this.signalingKeys.clear(existing.deviceId)
    }
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
      const config = JSON.parse(value) as CompanionConfig
      if (config.signalingPrivateKeyJwk) {
        config.signalingPrivateKey = await importV2SigningPrivateKey(config.signalingPrivateKeyJwk)
      }
      return config
    } catch {
      // get() throws when the key is absent — treat as "not paired yet".
      return null
    }
  }

  async save(config: CompanionConfig): Promise<void> {
    const plugin = await this.loader()
    const persisted = { ...config }
    delete persisted.signalingPrivateKey
    await plugin.set({ key: CONFIG_KEY, value: JSON.stringify(persisted) })
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
