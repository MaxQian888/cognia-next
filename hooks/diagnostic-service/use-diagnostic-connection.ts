"use client"

/**
 * The one place a surface asks "which diagnostic service, and what may I do
 * with it?".
 *
 * Three consumers need the same answer and would otherwise each grow their own
 * copy: the `/logs` Incidents channel (to submit a crash), the `/logs` Service
 * channel (to triage), and the Settings connection card (to configure it).
 *
 * The connection is per local account (ADR-0054) and its identity-provider
 * session token never leaves the OS keyring — see `lib/diagnostic-service/
 * connection.ts` for why that split exists.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { DiagnosticServiceClient, type DiagnosticFetch } from "@/lib/diagnostic-service/client"
import {
  clearDiagnosticConnection,
  DiagnosticGrantCache,
  loadDiagnosticConnection,
  loadDiagnosticSessionToken,
  saveDiagnosticConnection,
  saveDiagnosticSessionToken,
  type StoredDiagnosticConnection,
} from "@/lib/diagnostic-service/connection"
import { rolePermits, type DiagnosticRole } from "@/lib/diagnostic-service/types"
import { createPlatformFetch, reachesNonCorsHosts } from "@/lib/network/platform-fetch"
import { useAccountStore } from "@/stores/account/account-store"

export interface DiagnosticConnectionState {
  /** The unlocked local account these facts belong to, or null. */
  accountId: string | null
  /** Null until an account is unlocked and a connection has been stored. */
  connection: StoredDiagnosticConnection | null
  /** Whether a session token is present, i.e. whether requests can be signed. */
  authenticated: boolean
  /** Still reading the stored connection and probing the keyring. */
  loading: boolean
  /** Role the last successful grant exchange reported, if any. */
  role: DiagnosticRole | null
  /** Whether this shell can reach a host that serves no CORS headers. */
  reachable: boolean
  /** A client bound to this connection, or null when unconfigured. */
  client: DiagnosticServiceClient | null
  /** Whether the current role satisfies `required`. */
  can: (required: DiagnosticRole) => boolean
  connect: (
    input: StoredDiagnosticConnection & { sessionToken?: string }
  ) => Promise<StoredDiagnosticConnection>
  disconnect: () => Promise<void>
  /** Re-read from storage — used after another surface changed the connection. */
  reload: () => void
}

/** Injected in tests; production uses the platform-routed fetch. */
export interface DiagnosticConnectionDeps {
  fetchImpl?: DiagnosticFetch
  accountId?: string | null
}

export function useDiagnosticConnection(
  deps: DiagnosticConnectionDeps = {}
): DiagnosticConnectionState {
  const storeAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountId = deps.accountId !== undefined ? deps.accountId : storeAccountId
  const [connection, setConnection] = useState<StoredDiagnosticConnection | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [role, setRole] = useState<DiagnosticRole | null>(null)
  const [generation, setGeneration] = useState(0)

  const fetchImpl = useMemo(
    () => deps.fetchImpl ?? createPlatformFetch(),
    // `createPlatformFetch` reads the shell once; rebuilding it per render
    // would rebuild the proxied fetch with it.
    [deps.fetchImpl]
  )

  // Every state write happens in the async continuation, never synchronously
  // in the effect body: `react-hooks/set-state-in-effect` blocks the latter,
  // and the cascading render it warns about is real here — three writes.
  useEffect(() => {
    let active = true
    const stored = accountId ? loadDiagnosticConnection(accountId) : null
    const token = accountId ? loadDiagnosticSessionToken(accountId) : Promise.resolve(null)
    void token
      .then((value) => {
        if (!active) return
        // A stored URL whose keyring entry was purged must not render as
        // connected: it would look configured and fail on first request.
        setConnection(stored)
        setAuthenticated(Boolean(stored && value))
        setRole(stored?.lastKnownRole ?? null)
      })
      .catch(() => {
        if (active) setAuthenticated(false)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [accountId, generation])

  const grants = useMemo(() => {
    if (!connection || !accountId || !authenticated) return null
    return new DiagnosticGrantCache({
      connection,
      sessionToken: () => loadDiagnosticSessionToken(accountId),
      fetchImpl,
      onRole: (observed) => {
        setRole(observed)
        // Persist it so the next session renders the right surfaces before its
        // first request, instead of hiding them until one lands.
        saveDiagnosticConnection(accountId, { ...connection, lastKnownRole: observed })
      },
    })
  }, [accountId, authenticated, connection, fetchImpl])

  const client = useMemo(() => {
    if (!connection || !grants) return null
    try {
      return new DiagnosticServiceClient({
        baseUrl: connection.baseUrl,
        grant: () => grants.grant(),
        fetchImpl,
      })
    } catch {
      // `normalizeServiceUrl` throws on a stored URL that no longer passes the
      // scheme rule — an app upgrade tightening it, or a hand-edited entry.
      return null
    }
  }, [connection, fetchImpl, grants])

  const connect = useCallback(
    async (input: StoredDiagnosticConnection & { sessionToken?: string }) => {
      if (!accountId) throw new Error("no unlocked account")
      const { sessionToken, ...record } = input
      // Token first: a crash between the two writes should leave a connection
      // that cannot authenticate rather than a URL-less orphan secret.
      if (sessionToken) await saveDiagnosticSessionToken(accountId, sessionToken)
      const saved = saveDiagnosticConnection(accountId, record)
      setConnection(saved)
      setRole(saved.lastKnownRole)
      setAuthenticated(sessionToken ? true : authenticated)
      return saved
    },
    [accountId, authenticated]
  )

  const disconnect = useCallback(async () => {
    if (!accountId) return
    await clearDiagnosticConnection(accountId)
    setConnection(null)
    setAuthenticated(false)
    setRole(null)
  }, [accountId])

  const can = useCallback(
    (required: DiagnosticRole) => (role ? rolePermits(role, required) : false),
    [role]
  )

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  return useMemo(
    () => ({
      accountId,
      connection,
      authenticated,
      loading,
      role,
      reachable: reachesNonCorsHosts(),
      client,
      can,
      connect,
      disconnect,
      reload,
    }),
    [accountId, authenticated, can, client, connect, connection, disconnect, loading, reload, role]
  )
}
