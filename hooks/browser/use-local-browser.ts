"use client"

/**
 * The desktop's local browser runtime as the pane and Settings see it
 * (ADR-0201): whether the managed Chromium is installed, the live install
 * progress, and which of the user's own browsers can be attached.
 *
 * Every read goes through `lib/browser/local-client.ts`; off the desktop there
 * is no runtime to ask, so the hook stays idle and reports `supported: false`
 * rather than issuing commands a web shell cannot serve.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
  localBrowser,
  type LocalBrowserInstallProgress,
  type LocalBrowserStatus,
  type UserChromeCandidate,
} from "@/lib/browser/local-client"
import { isTauri } from "@/lib/tauri"

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

export interface UseLocalBrowserOptions {
  /** Defaults to "inside the desktop shell". */
  enabled?: boolean
}

export interface LocalBrowserState {
  supported: boolean
  status: LocalBrowserStatus | null
  /** The last install progress event; null when no install ran this session. */
  progress: LocalBrowserInstallProgress | null
  /** Discovered browsers; empty until discovery answered. */
  userChrome: UserChromeCandidate[]
  /** True while install or uninstall is in flight. */
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  install: () => Promise<boolean>
  uninstall: () => Promise<boolean>
  discoverUserChrome: () => Promise<void>
}

export function useLocalBrowser({ enabled }: UseLocalBrowserOptions = {}): LocalBrowserState {
  const supported = enabled ?? isTauri()
  const [status, setStatus] = useState<LocalBrowserStatus | null>(null)
  const [progress, setProgress] = useState<LocalBrowserInstallProgress | null>(null)
  const [userChrome, setUserChrome] = useState<UserChromeCandidate[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!supported) return
    try {
      const next = await localBrowser.status()
      if (mountedRef.current) setStatus(next)
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause))
    }
  }, [supported])

  const discoverUserChrome = useCallback(async () => {
    if (!supported) return
    try {
      const candidates = await localBrowser.discoverUserChrome()
      if (mountedRef.current) setUserChrome(candidates)
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause))
    }
  }, [supported])

  useEffect(() => {
    if (!supported) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void localBrowser
      .onInstallProgress((next) => {
        if (disposed) return
        setProgress(next)
        if (next.phase === "done" || next.phase === "failed") void refresh()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    // Resolved in callbacks (not through `refresh`) so the first read is an
    // external-system subscription, not a synchronous effect-body update.
    localBrowser.status().then(
      (next) => {
        if (!disposed) setStatus(next)
      },
      (cause: unknown) => {
        if (!disposed) setError(errorText(cause))
      }
    )
    localBrowser.discoverUserChrome().then(
      (candidates) => {
        if (!disposed) setUserChrome(candidates)
      },
      (cause: unknown) => {
        if (!disposed) setError(errorText(cause))
      }
    )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [supported, refresh])

  const install = useCallback(async () => {
    if (!supported) return false
    setBusy(true)
    setError(null)
    setProgress({ phase: "downloading", receivedBytes: 0 })
    try {
      const next = await localBrowser.install()
      if (mountedRef.current) setStatus(next)
      if (next.error) {
        if (mountedRef.current) setError(next.error)
        return false
      }
      return next.installed
    } catch (cause) {
      if (mountedRef.current) {
        setError(errorText(cause))
        setProgress({ phase: "failed", message: errorText(cause) })
      }
      return false
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [supported])

  const uninstall = useCallback(async () => {
    if (!supported) return false
    setBusy(true)
    setError(null)
    try {
      const next = await localBrowser.uninstall()
      if (mountedRef.current) {
        setStatus(next)
        setProgress(null)
      }
      return !next.installed
    } catch (cause) {
      if (mountedRef.current) setError(errorText(cause))
      return false
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [supported])

  return {
    supported,
    status,
    progress,
    userChrome,
    busy,
    error,
    refresh,
    install,
    uninstall,
    discoverUserChrome,
  }
}
