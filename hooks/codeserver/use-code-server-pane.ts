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
  type CodeServerExited,
  type CodeServerProfile,
  codeServerClient,
} from "@/lib/codeserver/client"
import {
  claimCodeServerPane,
  getCodeServerPaneOwner,
  releaseCodeServerPane,
  setCodeServerPaneVisible,
  updateCodeServerPaneRect,
} from "@/lib/codeserver/pane-manager"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * `unsupported` — no code-server binary for this OS; `starting` —
 * checking support / spawning / health-polling; `downloading` — first-run fetch
 * in flight; `ready` — serving (native webview claimed); `error` —
 * install/spawn/embed failed (retryable).
 */
export type CodeServerPhase = "unsupported" | "starting" | "downloading" | "ready" | "error"

export interface UseCodeServerPane {
  phase: CodeServerPhase
  /**
   * Whether the native webview is actually up and pointed at this root. `phase`
   * reaches `ready` a beat earlier — when code-server answers `/healthz` — so a
   * surface that hides its placeholder on `phase` alone flashes bare background
   * until the webview paints. Gate the placeholder on this instead.
   */
  mounted: boolean
  /** Download fraction 0..1 while `downloading`; null otherwise / unknown. */
  progress: number | null
  error: string | null
  retry: () => void
  /**
   * Stop the code-server serving this root and bring a fresh one up.
   *
   * Distinct from {@link retry}, which re-`ensure`s and therefore reuses a healthy
   * instance: some changes are only read at workbench startup (`argv.json`'s
   * display language, a newly side-loaded extension), so applying them means
   * actually replacing the process.
   */
  restart: () => void
}

export interface UseCodeServerPaneOptions {
  /** Project root code-server should serve. */
  root: string
  /** Stable id identifying this surface to the pane manager. */
  ownerId: string
  /**
   * Which code-server trust domain to serve `root` from. Defaults to `managed`,
   * matching the backend default. The two profiles are separate processes on
   * separate ports, so switching this re-`ensure`s and re-navigates the pane
   * rather than reconfiguring the running one.
   */
  profile?: CodeServerProfile
  /** Called when another surface claims the shared pane away from this one. */
  onRevoked: () => void
}

/**
 * Drives the code-server "Pro IDE" pane over a reserved `ref` div: ensures a
 * loopback code-server is serving `root` (downloading it on first use, with
 * progress), then claims the shared native webview from
 * {@link claimCodeServerPane} and keeps its bounds / visibility synced.
 *
 * The webview itself is owned by `lib/codeserver/pane-manager`, not by this
 * hook — unmounting only releases and parks it, so VS Code keeps its open
 * editors, cursor and terminals when the user switches tabs or routes.
 */
export function useCodeServerPane(
  ref: RefObject<HTMLElement | null>,
  options: UseCodeServerPaneOptions
): UseCodeServerPane {
  const { root, ownerId, profile = "managed", onRevoked } = options
  const [phase, setPhase] = useState<CodeServerPhase>("starting")
  const [mounted, setMounted] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [port, setPort] = useState<number | null>(null)

  const visible = useRegionVisibility(ref)

  const rectRef = useRef<ElementRect | null>(null)
  const visibleRef = useRef(visible)
  const url = port != null ? `http://127.0.0.1:${port}/` : null
  const urlRef = useRef(url)

  // Keep the revoke callback current without re-claiming on every render.
  const onRevokedRef = useRef(onRevoked)
  useEffect(() => {
    onRevokedRef.current = onRevoked
  }, [onRevoked])

  // Claim the shared pane once both the loopback url and a rect are known; both
  // the rect callback and the url effect call this so whichever lands last wins.
  const claimPane = useCallback(() => {
    const rect = rectRef.current
    const target = urlRef.current
    if (!isTauri() || !target || !rect) return
    void claimCodeServerPane(ownerId, target, rect, () => onRevokedRef.current()).then(
      () => {
        setMounted(true)
        // Claiming shows the pane; re-park immediately if it must stay hidden.
        if (!visibleRef.current) setCodeServerPaneVisible(ownerId, false)
      },
      (cause) => {
        setMounted(false)
        setError(String(cause))
        setPhase("error")
      }
    )
  }, [ownerId])

  const onRect = useCallback(
    (next: ElementRect) => {
      rectRef.current = next
      if (!isTauri()) return
      if (getCodeServerPaneOwner() !== ownerId) {
        claimPane()
        return
      }
      updateCodeServerPaneRect(ownerId, next)
    },
    [claimPane, ownerId]
  )
  useElementRect(ref, onRect, { trackState: false })

  // Ensure code-server is up for `root` (re-runs on root/retry change). All
  // state transitions live inside the async task so none run synchronously in
  // the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    let unlistenProgress: (() => void) | null = null
    void (async () => {
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
        const status = await codeServerClient.ensure(root, profile)
        if (cancelled) return
        const nextPort = status.port ?? null
        urlRef.current = nextPort != null ? `http://127.0.0.1:${nextPort}/` : null
        setPort(nextPort)
        setProgress(null)
        setPhase("ready")
        claimPane()
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
  }, [root, profile, attempt, claimPane])

  // Claim the pane once the port (→ url) is known.
  useEffect(() => {
    urlRef.current = url
    claimPane()
  }, [url, claimPane])

  // A code-server that dies mid-session leaves the native webview showing a dead
  // page with no way back. The backend watchdog reports it; leave `ready` so the
  // retry affordance appears. The retry below is a plain re-`ensure`: the
  // watchdog also flags the instance unhealthy backend-side, so `codeserver_ensure`
  // kills that child and spawns a fresh one instead of handing back the port of a
  // process that is alive but no longer serving (`codeserver::process`).
  useEffect(() => {
    if (!isTauri() || port == null) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<CodeServerExited>(CODESERVER_EVENTS.instanceExited, (payload) => {
      if (cancelled) return
      // Locally the port is the sharper key — `root` is the backend's
      // canonicalized spelling and may not equal the one this surface holds.
      // Through a remote host it is the *only* wrong key: the event carries the
      // host's own loopback port while `port` here is the desktop relay's, so a
      // port match can never happen and a crashed remote instance would sit
      // there as a dead page. Fall back to the root in that case.
      const matches = isRemoteHostActive()
        ? payload.root === root || payload.root.replace(/\/+$/, "") === root.replace(/\/+$/, "")
        : payload.port === port
      if (!matches) return
      setError(`code-server for ${payload.root} stopped responding`)
      setPhase("error")
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [port, root])

  // Reflect visibility onto the native webview. Two things park it: the region
  // going off-screen (tab switch / modal), and any phase other than `ready` —
  // the webview floats ABOVE the DOM and cannot be covered, so leaving a dead or
  // loading instance on screen would hide this pane's own error + retry UI.
  const shouldShow = visible && phase === "ready"
  useEffect(() => {
    visibleRef.current = shouldShow
    if (!isTauri()) return
    setCodeServerPaneVisible(ownerId, shouldShow)
  }, [ownerId, shouldShow])

  // Release — never destroy — on unmount, so the next surface to claim the pane
  // gets the same live VS Code back instead of a fresh workbench boot.
  useEffect(() => {
    return () => {
      releaseCodeServerPane(ownerId)
    }
  }, [ownerId])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const restart = useCallback(() => {
    // Back to `starting` first so the placeholder covers the pane while the old
    // workbench goes away — the native webview floats above the DOM and would
    // otherwise sit there showing a dead page.
    setMounted(false)
    setPhase("starting")
    // Stop, then bump `attempt` regardless: a failed stop still leaves the
    // ensure-with-a-dead-instance path (which prunes and respawns) as the way out,
    // whereas swallowing the bump would strand the pane in `starting`.
    void codeServerClient
      .stop(root)
      .catch(() => undefined)
      .then(() => setAttempt((n) => n + 1))
  }, [root])

  return { phase, mounted, progress, error, retry, restart }
}
