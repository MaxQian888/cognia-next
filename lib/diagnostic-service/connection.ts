"use client"

/**
 * Where the app remembers *which* diagnostic service it talks to, and how it
 * gets a grant for it.
 *
 * Split the way `/servers` splits the same problem (ADR-0059): the non-secret
 * half — URL, tenant, project, whether submission is automatic — is ordinary
 * per-account local state, and the identity-provider session token is a secret
 * that only ever lives in the OS keyring. Neither half goes into Dexie, so a
 * database export can never carry an operator's session.
 *
 * Account-scoped because a machine can hold several local accounts
 * (ADR-0054) and they may legitimately report to different services.
 */

import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

import { exchangeOidcGrant, normalizeServiceUrl, type DiagnosticFetch } from "./client"
import type { DiagnosticRole } from "./types"

const CONNECTION_KEY_PREFIX = "cognia.diagnostic-service.connection"
const KEYRING_NAMESPACE = "diagnostic-service-oidc"

/**
 * Refresh a grant this long before it actually expires.
 *
 * Grants live 15 minutes. Without a margin, a request issued in the last
 * moments of a grant's life arrives after it died and fails with a 401 that
 * looks like a configuration problem rather than a clock race.
 */
const GRANT_REFRESH_MARGIN_MS = 60_000

export interface DiagnosticConnection {
  /** Normalized service origin, path prefix preserved. */
  baseUrl: string
  tenantId: string
  projectId: string
  /**
   * Stable per-install identifier the service scopes uploader grants to.
   *
   * An uploader may only read back incidents carrying its own installation id,
   * which is what stops one user's app from enumerating another's crashes on a
   * shared tenant.
   */
  installationId: string
  /**
   * When true, a captured crash is packaged and submitted without the consent
   * dialog. Off by default and deliberately separate from "diagnostics are
   * enabled": ADR-0102 requires previewed consent unless the user opts into
   * automatic submission as its own decision.
   */
  autoSubmit: boolean
}

export interface StoredDiagnosticConnection extends DiagnosticConnection {
  /** Role the last successful exchange reported. Advisory: the server decides. */
  lastKnownRole: DiagnosticRole | null
}

function connectionKey(accountId: string): string {
  return `${CONNECTION_KEY_PREFIX}.${accountId}`
}

/** Storage seam so tests need neither `localStorage` nor a keyring. */
export interface ConnectionStoreDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
  keyring?: KeyringStore
}

function localStore(deps: ConnectionStoreDeps): ConnectionStoreDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

let sharedKeyring: KeyringStore | null = null
function keyringStore(deps: ConnectionStoreDeps): KeyringStore {
  if (deps.keyring) return deps.keyring
  sharedKeyring ??= createKeyringStore(KEYRING_NAMESPACE)
  return sharedKeyring
}

function isConnectionShape(value: unknown): value is StoredDiagnosticConnection {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.baseUrl === "string" &&
    typeof candidate.tenantId === "string" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.installationId === "string"
  )
}

/**
 * Read the stored connection, or `null` when there is none.
 *
 * A stored record that no longer parses — hand-edited, or written by a build
 * whose URL rule was looser — is removed rather than returned: a half-valid
 * connection renders a configured-looking panel that fails on first use.
 */
export function loadDiagnosticConnection(
  accountId: string,
  deps: ConnectionStoreDeps = {}
): StoredDiagnosticConnection | null {
  const store = localStore(deps)
  if (!store) return null
  const raw = store.getItem(connectionKey(accountId))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isConnectionShape(parsed)) throw new Error("unrecognized connection shape")
    return {
      ...parsed,
      baseUrl: normalizeServiceUrl(parsed.baseUrl),
      autoSubmit: parsed.autoSubmit === true,
      lastKnownRole: parsed.lastKnownRole ?? null,
    }
  } catch {
    store.removeItem(connectionKey(accountId))
    return null
  }
}

export function saveDiagnosticConnection(
  accountId: string,
  connection: StoredDiagnosticConnection,
  deps: ConnectionStoreDeps = {}
): StoredDiagnosticConnection {
  const normalized: StoredDiagnosticConnection = {
    ...connection,
    baseUrl: normalizeServiceUrl(connection.baseUrl),
  }
  localStore(deps)?.setItem(connectionKey(accountId), JSON.stringify(normalized))
  return normalized
}

/**
 * Forget the connection and its session token.
 *
 * The token is dropped first: a crash between the two writes should leave an
 * unusable connection rather than an orphaned secret in the keyring.
 */
export async function clearDiagnosticConnection(
  accountId: string,
  deps: ConnectionStoreDeps = {}
): Promise<void> {
  await keyringStore(deps).delete(accountId)
  localStore(deps)?.removeItem(connectionKey(accountId))
}

export function saveDiagnosticSessionToken(
  accountId: string,
  sessionToken: string,
  deps: ConnectionStoreDeps = {}
): Promise<void> {
  return keyringStore(deps).save(accountId, sessionToken)
}

export function loadDiagnosticSessionToken(
  accountId: string,
  deps: ConnectionStoreDeps = {}
): Promise<string | null> {
  return keyringStore(deps).load(accountId)
}

interface CachedGrant {
  grant: string
  role: DiagnosticRole
  expiresAtMs: number
}

/**
 * A grant provider that mints on demand and reuses until nearly expired.
 *
 * One instance per connection. `role` is exposed so a console can hide the
 * surfaces this operator cannot use instead of discovering its permissions
 * through a wall of 403s.
 */
export class DiagnosticGrantCache {
  private cached: CachedGrant | null = null
  private inFlight: Promise<CachedGrant> | null = null

  constructor(
    private readonly options: {
      connection: DiagnosticConnection
      sessionToken: () => Promise<string | null>
      fetchImpl: DiagnosticFetch
      now?: () => number
      /**
       * Called after each successful exchange with the role the service
       * assigned.
       *
       * Pushed rather than polled: a consumer that read `role` off the cache
       * would only ever see it change on some *other* render, which is how a
       * console ends up rendering surfaces the operator cannot use.
       */
      onRole?: (role: DiagnosticRole) => void
    }
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  get role(): DiagnosticRole | null {
    return this.cached?.role ?? null
  }

  /** Drop the cached grant, e.g. after the service answered 401. */
  invalidate(): void {
    this.cached = null
  }

  async grant(): Promise<string> {
    const cached = this.cached
    if (cached && cached.expiresAtMs - GRANT_REFRESH_MARGIN_MS > this.now) return cached.grant
    // Collapse concurrent callers onto one exchange: a console that opens
    // three panels at once would otherwise burn three grants and race on which
    // one wins the cache.
    this.inFlight ??= this.exchange().finally(() => {
      this.inFlight = null
    })
    return (await this.inFlight).grant
  }

  private async exchange(): Promise<CachedGrant> {
    const sessionToken = await this.options.sessionToken()
    if (!sessionToken) {
      const { DiagnosticServiceError } = await import("./client")
      throw new DiagnosticServiceError("session_token_missing", 401)
    }
    const response = await exchangeOidcGrant({
      baseUrl: this.options.connection.baseUrl,
      sessionToken,
      installationId: this.options.connection.installationId,
      fetchImpl: this.options.fetchImpl,
    })
    const fresh: CachedGrant = {
      grant: response.grant,
      role: response.role,
      expiresAtMs: this.now + response.expiresInSeconds * 1000,
    }
    this.cached = fresh
    this.options.onRole?.(fresh.role)
    return fresh
  }
}
