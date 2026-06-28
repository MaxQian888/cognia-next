"use client"

// State machine for the standalone (BYOK) web-search surface. Owns the query
// text, the in-flight `AbortController`, and the result/error. The actual work
// lives in `runStandaloneSearchAnswer` (search + cited synthesis) — this hook is
// just the React-facing wrapper so the panel stays presentational.

import { useCallback, useRef, useState } from "react"

import {
  runStandaloneSearchAnswer,
  StandaloneSearchError,
  type StandaloneSearchAnswer,
  type StandaloneSearchErrorCode,
} from "@/lib/search/standalone-answer"

export type StandaloneSearchStatus = "idle" | "loading" | "done" | "error"

export interface UseStandaloneSearch {
  query: string
  setQuery: (q: string) => void
  status: StandaloneSearchStatus
  result?: StandaloneSearchAnswer
  errorCode?: StandaloneSearchErrorCode
  errorMessage?: string
  run: () => Promise<void>
  cancel: () => void
}

export interface UseStandaloneSearchOptions {
  /** Test seam — inject a fake runner. */
  runImpl?: typeof runStandaloneSearchAnswer
}

export function useStandaloneSearch(options: UseStandaloneSearchOptions = {}): UseStandaloneSearch {
  const runImpl = options.runImpl ?? runStandaloneSearchAnswer
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<StandaloneSearchStatus>("idle")
  const [result, setResult] = useState<StandaloneSearchAnswer | undefined>(undefined)
  const [errorCode, setErrorCode] = useState<StandaloneSearchErrorCode | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const controllerRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setStatus((s) => (s === "loading" ? "idle" : s))
  }, [])

  const run = useCallback(async () => {
    // Cancel any in-flight request before starting a new one.
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    setStatus("loading")
    setResult(undefined)
    setErrorCode(undefined)
    setErrorMessage(undefined)

    try {
      const answer = await runImpl({ query, signal: controller.signal })
      if (controller.signal.aborted) return
      setResult(answer)
      setStatus("done")
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus("idle")
        return
      }
      if (err instanceof StandaloneSearchError) {
        setErrorCode(err.code)
        setErrorMessage(err.message)
      } else {
        setErrorCode("search-failed")
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
      setStatus("error")
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [query, runImpl])

  return { query, setQuery, status, result, errorCode, errorMessage, run, cancel }
}
