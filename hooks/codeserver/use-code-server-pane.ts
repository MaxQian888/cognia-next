"use client"

import { type RefObject, useCallback, useEffect, useRef, useState } from "react"

// The two generic browser-pane primitives are engine-agnostic (rect tracking +
// region visibility, see their own docstrings) — reused here verbatim.
import { useElementRect } from "@/hooks/browser/use-element-rect"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"
import type { ElementRect } from "@/lib/browser/protocol"
import {
  CODESERVER_EVENTS,
  type CodeServerDownloadProgress,
  codeServerClient,
} from "@/lib/codeserver/client"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * `idle` — not active; `unsupported` — no code-server binary for this OS;
 * `starting` — spawning/health-polling; `downloading` — first-run fetch in
 * flight; `ready` — serving (native webview mounted); `error` — install/spawn
 * failed (retryable).
 */
export type CodeServerPhase =
  "idle" | "unsupported" | "starting" | "downloading" | "ready" | "error"

export interface UseCodeServerPane {
  phase: CodeServerPhase
  /** Download fraction 0..1 while `downloading`; null otherwise / unknown. */
  progress: number | null
  error: string | null
  retry: () => void
}

const ZERO_RECT: ElementRect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * Owns the code-server "Pro IDE" pane over a reserved `ref` div: ensures a
 * loopback code-server is serving `root` (downloading it on first use, with
 * progress), then mounts + positions the dedicated native webview and keeps its
 * bounds / visibility synced — mirroring the in-app browser's embedded-pane
 * lifecycle ({@link useElementRect} + {@link useRegionVisibility}) but against a
 * separate `codeserver-embed` webview so it coexists with the browser preview.
 */
export function useCodeServerPane(
  ref: RefObject<HTMLElement | null>,
  options: { root: string; active: boolean }
): UseCodeServerPane {
  const { root, active } = options
  const [phase, setPhase] = useState<CodeServerPhase>("idle")
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [port, setPort] = useState<number | null>(null)

  const visible = useRegionVisibility(ref)

  const createdRef = useRef(false)
  const rectRef = useRef<ElementRect | null>(null)
  const visibleRef = useRef(visible)
  const url = port != null ? `http://127.0.0.1:${port}/` : null
  const urlRef = useRef(url)

  // Create the webview once both the loopback url and a rect are known; both
  // the rect callback and the url effect call this so whichever lands last wins.
  const syncWebview = useCallback(() => {
    const rect = rectRef.current
    const target = urlRef.current
    if (!isTauri() || !target || !rect || createdRef.current) return
    createdRef.current = true
    void codeServerClient.embedCreate(target, rect).then(
      () => {
        if (!visibleRef.current) {
          void codeServerClient.embedSetVisible(false, rectRef.current ?? rect).catch(() => {})
        }
      },
      () => {
        createdRef.current = false
      }
    )
  }, [])

  const onRect = useCallback(
    (next: ElementRect) => {
      rectRef.current = next
      if (!isTauri()) return
      if (!createdRef.current) {
        syncWebview()
        return
      }
      // Parked (hidden) webviews sit off-screen; don't churn their bounds.
      if (visibleRef.current) void codeServerClient.embedSetBounds(next).catch(() => {})
    },
    [syncWebview]
  )
  useElementRect(ref, onRect, { trackState: false })

  // Ensure code-server is up for `root` (re-runs on root/active/retry change).
  // All state transitions live inside the async task so none run synchronously
  // in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    let unlistenProgress: (() => void) | null = null
    void (async () => {
      if (!active) {
        setPhase("idle")
        return
      }
      if (!isTauri()) {
        setPhase("unsupported")
        return
      }
      setError(null)
      setProgress(null)
      const ok = await codeServerClient.supported().catch(() => false)
      if (cancelled) return
      if (!ok) {
        setPhase("unsupported")
        return
      }
      setPhase("starting")
      void onTauriEvent<CodeServerDownloadProgress>(CODESERVER_EVENTS.downloadProgress, (p) => {
        if (cancelled || p.stage !== "downloading") return
        setPhase("downloading")
        setProgress(p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : null)
      }).then((fn) => {
        if (cancelled) fn()
        else unlistenProgress = fn
      })
      try {
        const status = await codeServerClient.ensure(root)
        if (cancelled) return
        setPort(status.port ?? null)
        setProgress(null)
        setPhase("ready")
      } catch (e) {
        if (cancelled) return
        setError(String(e))
        setPhase("error")
      }
    })()
    return () => {
      cancelled = true
      safeUnlisten(unlistenProgress)
    }
  }, [root, active, attempt])

  // Mount the webview once the port (→ url) is known.
  useEffect(() => {
    urlRef.current = url
    syncWebview()
  }, [url, syncWebview])

  // Reflect region visibility onto the native webview (park off-screen when the
  // tab is switched away / a modal covers it).
  useEffect(() => {
    visibleRef.current = visible
    if (!isTauri() || !createdRef.current) return
    void codeServerClient.embedSetVisible(visible, rectRef.current ?? ZERO_RECT).catch(() => {})
  }, [visible])

  // Tear the webview down when the pane goes inactive (tab switched) — the
  // code-server process stays up so re-opening is instant.
  useEffect(() => {
    if (active) return
    if (createdRef.current) {
      void codeServerClient.embedDestroy().catch(() => {})
      createdRef.current = false
    }
  }, [active])

  // Final teardown on unmount.
  useEffect(() => {
    return () => {
      if (createdRef.current) void codeServerClient.embedDestroy().catch(() => {})
    }
  }, [])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return { phase, progress, error, retry }
}
