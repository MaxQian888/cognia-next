"use client"

/**
 * Runs automatic crash-report submission once per launch for the unlocked
 * account (see `lib/diagnostic-service/auto-submit.ts` for the rules).
 *
 * Once per launch is the right cadence: a crash report is only ever *detected*
 * at launch. A Rust panic or a native fault takes the process down with it,
 * and the mobile plugin collects the previous run's report on start, so there
 * is never a new report to find mid-session.
 *
 * Deliberately not built on `useDiagnosticConnection`: that hook reads the
 * keyring and probes the operator's role, neither of which submitting this
 * device's own crash needs (the desktop proves its installation with its own
 * key; mobile mints an anonymous grant from the installation identity), and
 * neither of which belongs on every app start.
 */

import { useEffect, useRef, useState } from "react"
import { loggers } from "@cognia/logging"

import { loadDiagnosticIncidents } from "@/hooks/logging/use-diagnostic-incidents"
import {
  runAutoSubmitOnce,
  type AutoSubmitIncident,
  type AutoSubmitOutcome,
  type AutoSubmitStoreDeps,
} from "@/lib/diagnostic-service/auto-submit"
import type { DiagnosticFetch } from "@/lib/diagnostic-service/client"
import {
  loadDiagnosticConnection,
  saveDiagnosticConnection,
  type StoredDiagnosticConnection,
} from "@/lib/diagnostic-service/connection"
import {
  submitIncidentReport,
  type IncidentConsentDecision,
  type SubmitIncidentResult,
} from "@/lib/diagnostic-service/submit-incident"
import {
  resolveSubmissionRuntime,
  type DiagnosticSubmissionRuntime,
} from "@/lib/native/diagnostic-submit"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { useAccountStore } from "@/stores/account/account-store"

export type DiagnosticAutoSubmitStatus = "idle" | "running" | "done"

/** Seams for the tests; production passes nothing. */
export interface DiagnosticAutoSubmitDeps {
  /** Overrides the unlocked account from the account store. */
  accountId?: string | null
  loadConnection?: (accountId: string) => StoredDiagnosticConnection | null
  saveConnection?: (accountId: string, connection: StoredDiagnosticConnection) => void
  resolveRuntime?: () => Promise<DiagnosticSubmissionRuntime | null>
  listIncidents?: () => Promise<AutoSubmitIncident[]>
  submit?: (input: {
    connection: StoredDiagnosticConnection
    accountId: string
    incident: AutoSubmitIncident
    consent: IncidentConsentDecision
    fetchImpl: DiagnosticFetch
  }) => Promise<SubmitIncidentResult>
  fetchImpl?: DiagnosticFetch
  store?: AutoSubmitStoreDeps
  now?: () => Date
}

export interface UseDiagnosticAutoSubmitOptions {
  /** Called with each pass's outcomes when it sent (or tried to send) anything. */
  onOutcomes: (outcomes: AutoSubmitOutcome[]) => void
  deps?: DiagnosticAutoSubmitDeps
}

export function useDiagnosticAutoSubmit(
  options: UseDiagnosticAutoSubmitOptions
): DiagnosticAutoSubmitStatus {
  const { deps = {} } = options
  const storeAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountId = deps.accountId !== undefined ? deps.accountId : storeAccountId
  const [status, setStatus] = useState<DiagnosticAutoSubmitStatus>("idle")

  // The latest callback and seams, read by the once-per-account pass without
  // re-running it when a caller passes fresh closures. Written in an effect,
  // never during render.
  const latest = useRef({ onOutcomes: options.onOutcomes, deps })
  useEffect(() => {
    latest.current = { onOutcomes: options.onOutcomes, deps }
  })

  useEffect(() => {
    if (!accountId) return
    let active = true
    const { deps: current } = latest.current
    const loadConnection = current.loadConnection ?? ((id: string) => loadDiagnosticConnection(id))
    const connection = loadConnection(accountId)
    if (!connection?.autoSubmit) return

    // Every state write lands in the promise continuation, never in the
    // effect body (`react-hooks/set-state-in-effect`).
    void Promise.resolve()
      .then(async () => {
        setStatus("running")
        const runtime = await (current.resolveRuntime ?? (() => resolveSubmissionRuntime()))()
        if (!runtime) return []
        const incidents = await (current.listIncidents ?? (() => loadDiagnosticIncidents()))()
        const fetchImpl = current.fetchImpl ?? createPlatformFetch()
        const submit = current.submit ?? ((input) => submitIncidentReport(input))
        return runAutoSubmitOnce({
          accountId,
          connection,
          incidents,
          submit: (incident, consent) =>
            submit({ connection, accountId, incident, consent: { ...consent }, fetchImpl }),
          saveConnection: (next) =>
            (current.saveConnection ?? ((id, record) => void saveDiagnosticConnection(id, record)))(
              accountId,
              next
            ),
          now: current.now,
          store: current.store,
        })
      })
      .then((outcomes) => {
        if (!active) return
        setStatus("done")
        if (outcomes.length > 0) latest.current.onOutcomes(outcomes)
      })
      .catch((cause: unknown) => {
        // Listing the reports failed (an unreadable crash directory). The
        // Crash reports channel surfaces that itself; nothing was sent.
        loggers.native.warn("diagnostic auto-submit: pass did not run", {
          error: cause instanceof Error ? cause.message : String(cause),
        })
        if (active) setStatus("done")
      })
    return () => {
      active = false
    }
  }, [accountId])

  return status
}
