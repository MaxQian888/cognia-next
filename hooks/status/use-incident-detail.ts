"use client"

/**
 * Incident detail selected by `?incident=<id>` on the static `/status/` page.
 *
 * The page is one exported HTML file, so an incident deep link is a query
 * parameter, not a route. The ID is validated against the contract's opaque
 * ID shape before it is used in an API path; the URL is kept in sync with
 * `history.replaceState` so a reload reopens the same incident and closing
 * the dialog does not leave a dead parameter behind. A 404 is a "not found"
 * message, not an error.
 *
 * Mount this hook only on the client (the page renders it after the runtime
 * resolves), because the initial selection is read from `location.search`.
 */

import { useCallback, useEffect, useState } from "react"

import {
  parseIncidentDetail,
  STATUS_ID_PATTERN,
  statusApiUrl,
  type IncidentDetail,
  type StatusRuntime,
} from "@/lib/status/public-status"

import {
  isAbortError,
  statusGet,
  StatusRequestError,
  type StatusRequestErrorKind,
} from "./status-transport"

/** The contract's opaque-ID shape (lib/status/validate.ts). */
export const INCIDENT_ID_PATTERN = STATUS_ID_PATTERN
export const INCIDENT_QUERY_PARAM = "incident"

export interface IncidentQuery {
  id: string | null
  /** A parameter was present but is not a valid incident ID. */
  invalid: boolean
}

export function readIncidentQuery(search: string): IncidentQuery {
  const raw = new URLSearchParams(search).get(INCIDENT_QUERY_PARAM)
  if (raw === null) return { id: null, invalid: false }
  return INCIDENT_ID_PATTERN.test(raw) ? { id: raw, invalid: false } : { id: null, invalid: true }
}

/** Set or remove the incident parameter without a navigation or history entry. */
export function writeIncidentQuery(id: string | null): void {
  const url = new URL(window.location.href)
  if (id === null) url.searchParams.delete(INCIDENT_QUERY_PARAM)
  else url.searchParams.set(INCIDENT_QUERY_PARAM, id)
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
}

export type IncidentDetailStatus = "idle" | "invalid" | "loading" | "ready" | "not_found" | "error"

interface DetailResult {
  key: string
  status: "ready" | "not_found" | "error"
  detail: IncidentDetail | null
  errorKind: StatusRequestErrorKind | null
}

export interface IncidentDetailState {
  selectedId: string | null
  status: IncidentDetailStatus
  detail: IncidentDetail | null
  errorKind: StatusRequestErrorKind | null
  open: (id: string) => void
  close: () => void
  retry: () => void
}

export function useIncidentDetail(runtime: StatusRuntime | null): IncidentDetailState {
  const [query, setQuery] = useState<IncidentQuery>(() =>
    typeof window === "undefined"
      ? { id: null, invalid: false }
      : readIncidentQuery(window.location.search)
  )
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<DetailResult | null>(null)

  // An invalid parameter is reported once and removed from the address bar.
  useEffect(() => {
    if (query.invalid) writeIncidentQuery(null)
  }, [query.invalid])

  const apiBase = runtime?.apiBase ?? null
  const key = query.id === null ? null : `${query.id}#${attempt}`

  useEffect(() => {
    if (apiBase === null || query.id === null || key === null) return
    const id = query.id
    const controller = new AbortController()
    statusGet(statusApiUrl(apiBase, `/incidents/${encodeURIComponent(id)}`), parseIncidentDetail, {
      signal: controller.signal,
    }).then(
      ({ value }) => {
        if (controller.signal.aborted) return
        if (value.id !== id) {
          setResult({ key, status: "error", detail: null, errorKind: "invalid" })
          return
        }
        setResult({ key, status: "ready", detail: value, errorKind: null })
      },
      (caught: unknown) => {
        if (controller.signal.aborted || isAbortError(caught)) return
        const notFound =
          caught instanceof StatusRequestError &&
          caught.kind === "http" &&
          (caught.status === 404 || caught.code === "not_found")
        setResult({
          key,
          status: notFound ? "not_found" : "error",
          detail: null,
          errorKind: notFound
            ? null
            : caught instanceof StatusRequestError
              ? caught.kind
              : "network",
        })
      }
    )
    return () => controller.abort()
  }, [apiBase, query.id, key])

  const open = useCallback((id: string) => {
    if (!INCIDENT_ID_PATTERN.test(id)) return
    setQuery({ id, invalid: false })
    writeIncidentQuery(id)
  }, [])

  const close = useCallback(() => {
    setQuery({ id: null, invalid: false })
    writeIncidentQuery(null)
  }, [])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  let status: IncidentDetailStatus
  if (query.invalid) status = "invalid"
  else if (query.id === null) status = "idle"
  else if (result === null || result.key !== key) status = "loading"
  else status = result.status

  const current = result !== null && result.key === key ? result : null

  return {
    selectedId: query.id,
    status,
    detail: current?.detail ?? null,
    errorKind: current?.errorKind ?? null,
    open,
    close,
    retry,
  }
}
