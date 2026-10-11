"use client"

import { useCallback, useRef, useState } from "react"

import { requestMigrationLease } from "@/lib/remote-host/migration/service"
import { HostConsentRequiredError, type HostAdminLease } from "@/lib/tauri/admin-lease"

/** A lease this close to expiring is asked for again rather than used. */
const LEASE_MARGIN_MS = 60_000

export interface UseMigrationLeaseDeps {
  request?: (hostId: string) => Promise<HostAdminLease>
  now?: () => number
}

export interface UseMigrationLeaseResult {
  /**
   * The current lease's token, asking the host for one when there is none.
   * Resolves `null` while the host waits for a person to approve this device;
   * `awaitingConsent` then carries the code they approve, and calling again
   * after they have picks the lease up. Rejects when the host cannot be asked.
   */
  acquire: () => Promise<string | null>
  /** Set while the host waits for approval. `code` is null on a host too old to give one. */
  awaitingConsent: { code: string | null } | null
  requesting: boolean
  /** Drop the lease, e.g. after the host refused it. */
  forget: () => void
}

/**
 * The one admin lease a batch of moves, plugin transfers and take-backs uses
 * (ADR-0224, ADR-0153). Asked for only from an explicit user action, and kept
 * for the session of the panel so a batch prompts the host once. The secrets
 * panel (A6) holds its own, for its own operations, through `deps.request`.
 */
export function useMigrationLease(
  hostId: string | null,
  deps: UseMigrationLeaseDeps = {}
): UseMigrationLeaseResult {
  const request = deps.request ?? requestMigrationLease
  const now = deps.now ?? Date.now
  const lease = useRef<{ hostId: string; value: HostAdminLease } | null>(null)
  const [awaitingConsent, setAwaitingConsent] = useState<{ code: string | null } | null>(null)
  const [requesting, setRequesting] = useState(false)

  const acquire = useCallback(async (): Promise<string | null> => {
    if (!hostId) throw new Error("no remote host is selected")
    const current = lease.current
    if (current?.hostId === hostId && current.value.expiresAt - now() > LEASE_MARGIN_MS) {
      return current.value.token
    }
    setRequesting(true)
    try {
      const value = await request(hostId)
      lease.current = { hostId, value }
      setAwaitingConsent(null)
      return value.token
    } catch (error) {
      if (error instanceof HostConsentRequiredError) {
        setAwaitingConsent({ code: error.consentCode })
        return null
      }
      throw error
    } finally {
      setRequesting(false)
    }
  }, [hostId, now, request])

  const forget = useCallback(() => {
    lease.current = null
  }, [])

  return { acquire, awaitingConsent, requesting, forget }
}
