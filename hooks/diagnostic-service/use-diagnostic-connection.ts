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

/**
 * How much this surface knows about the operator's role.
 *
 * - `unknown` — there is nothing to ask: no client (unconfigured, or no
 *   identity session to exchange).
 * - `probing` — a client exists and the role is being learned from a grant
 *   exchange.
 * - `known` — `role` holds what the service assigned (or what it assigned
 *   last time, until the next exchange corrects it).
 * - `failed` — the exchange was refused or did not complete; `roleErrorCode`
 *   says why and `probeRole` tries again.
 *
 * The console used to treat a null role as "below Viewer". A fresh connection
 * has a null role until its first grant exchange, and nothing ever triggered
 * one, so every operator was told they could not read the console they had
 * just connected.
 */
export type DiagnosticRoleStatus = "unknown" | "probing" | "known" | "failed"

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
  /** Whether `role` is known, being learned, or could not be learned. */
  roleStatus: DiagnosticRoleStatus
  /** The service's code for the last failed role probe, when `roleStatus` is `failed`. */
  roleErrorCode: string | null
  /** Learn the role again (after `failed`, or to refresh a stale one). */
  probeRole: () => void
  /** Whether this shell can reach a host that serves no CORS headers. */
  reachable: boolean
  /** A client bound to this connection, or null when unconfigured. */
  client: DiagnosticServiceClient | null
  /** Whether the current role satisfies `required`. */
  can: (required: DiagnosticRole) => boolean
  /**
   * Store the connection (and the session token, when one is given).
   *
   * A new token resets the role, so `roleStatus` moves to `probing` and then
   * to `known` with the role the service assigned to *this* identity — the
   * Settings card shows it on the spot rather than whatever a previous token
   * had. A refused exchange does not undo the save: the connection is still
   * how this device submits its own crashes, which needs no token.
   * `roleStatus` / `roleErrorCode` report the refusal.
   */
  connect: (
    input: StoredDiagnosticConnection & { sessionToken?: string }
  ) => Promise<StoredDiagnosticConnection>
  disconnect: () => Promise<void>
  /** Re-read from storage — used after another surface changed the connection. */
  reload: () => void
}

interface RoleProbe {
  cache: DiagnosticGrantCache | null
  status: "idle" | "probing" | "done" | "failed"
  errorCode: string | null
}

const IDLE_PROBE: RoleProbe = { cache: null, status: "idle", errorCode: null }

/** The service's code, or a generic one for a transport failure. */
function codeOf(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return "network_unavailable"
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
  // Keyed by the grant cache it probed: a new connection or token builds a new
  // cache, and an outcome recorded against the old one must not leak onto it.
  const [probe, setProbe] = useState<RoleProbe>(IDLE_PROBE)

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

  /**
   * Exchange a grant to learn the role. Every write lands in the promise
   * continuation (`react-hooks/set-state-in-effect`), and an outcome for a
   * cache that has since been replaced is dropped.
   */
  const runProbe = useCallback((cache: DiagnosticGrantCache) => {
    void Promise.resolve()
      .then(() => {
        setProbe({ cache, status: "probing", errorCode: null })
        return cache.grant()
      })
      .then(
        () =>
          setProbe((current) =>
            current.cache === cache ? { cache, status: "done", errorCode: null } : current
          ),
        (cause: unknown) =>
          setProbe((current) =>
            current.cache === cache
              ? { cache, status: "failed", errorCode: codeOf(cause) }
              : current
          )
      )
  }, [])

  // Probe once per grant cache whenever the role is not known yet. A role
  // carried over from `lastKnownRole` is good enough to render with; the first
  // real request refreshes it through `onRole`.
  useEffect(() => {
    if (!grants || role !== null || probe.cache === grants) return
    runProbe(grants)
  }, [grants, probe.cache, role, runProbe])

  const probeRole = useCallback(() => {
    if (grants) runProbe(grants)
  }, [grants, runProbe])

  // Without a grant cache there is no one to ask, and a remembered role says
  // nothing about what this (absent) session may do.
  const roleStatus: DiagnosticRoleStatus = !grants
    ? "unknown"
    : probe.cache === grants && probe.status === "probing"
      ? "probing"
      : role
        ? "known"
        : probe.cache === grants && probe.status === "failed"
          ? "failed"
          : // A cache exists and the effect above is about to probe it.
            "probing"
  const roleErrorCode = probe.cache === grants && probe.status === "failed" ? probe.errorCode : null

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
      // A new identity session may carry a different role; the old one must
      // not be shown against it. Clearing it is what makes the probe below
      // learn this identity's role as soon as the new grant cache exists.
      const saved = saveDiagnosticConnection(accountId, {
        ...record,
        lastKnownRole: sessionToken ? null : record.lastKnownRole,
      })
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
    setProbe(IDLE_PROBE)
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
      roleStatus,
      roleErrorCode,
      probeRole,
      reachable: reachesNonCorsHosts(),
      client,
      can,
      connect,
      disconnect,
      reload,
    }),
    [
      accountId,
      authenticated,
      can,
      client,
      connect,
      connection,
      disconnect,
      loading,
      probeRole,
      reload,
      role,
      roleErrorCode,
      roleStatus,
    ]
  )
}
