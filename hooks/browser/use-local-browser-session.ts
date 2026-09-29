"use client"

/**
 * One local-runtime browser session behind the pane (ADR-0201): created on
 * mount for `local-chromium` or `user-chrome`, streamed into the canvas, bound
 * to the agent's engine routing while shown, and closed on unmount.
 *
 * Three runtime events matter to the pane and are folded in here:
 * `pages.changed` (the tab strip), `dialog.opened` (a native alert / confirm /
 * prompt that blocks the page until answered) and `session.closed`.
 *
 * An agent that reaches for local Chromium while no pane is showing it gets a
 * headless session of its own (`ensureAgentLocalEngine`), announced with
 * `BROWSER_AGENT_LOCAL_SESSION_EVENT`. A pane showing the same backend adopts
 * it — the user then watches exactly the page the agent is driving — and
 * closes the session it had created, which nothing else can see.
 *
 * The backend and attached browser are fixed for the hook's lifetime: the pane
 * remounts it (`key`) when either changes, so no state has to be reset here.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
  BROWSER_AGENT_LOCAL_SESSION_EVENT,
  configureLocalBrowserEngine,
  type BrowserAgentLocalSession,
} from "@/lib/browser/agent-engine"
import {
  localBrowser,
  type LocalBrowserEvent,
  type UserChromeBrowser,
} from "@/lib/browser/local-client"
import { LocalChromiumEngine, type LocalEngineBackend } from "@/lib/browser/local-chromium-engine"
import type { BrowserPageSummary } from "@/lib/browser/session-types"

export type LocalSessionState = "starting" | "ready" | "failed" | "closed"

export interface LocalBrowserDialog {
  type: string
  message: string
  defaultValue?: string
}

export interface UseLocalBrowserSessionOptions {
  backend: LocalEngineBackend
  /** Which of the user's browsers to attach (`user-chrome` only). */
  userChromeBrowser?: UserChromeBrowser | null
  /** Loaded once the session exists. */
  initialUrl?: string
  /** Receives every screencast frame (24-byte framed JPEG). */
  onFrame: (bytes: Uint8Array) => void
  /** Injectable for tests. */
  createSessionId?: () => string
}

export interface LocalBrowserSession {
  state: LocalSessionState
  error: string | null
  sessionId: string | null
  engine: LocalChromiumEngine | null
  pages: BrowserPageSummary[]
  activePageId: string | null
  dialog: LocalBrowserDialog | null
  dismissDialog: () => void
  refreshPages: () => Promise<void>
  restart: () => void
}

function errorCode(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "browser_local_unavailable"
}

function defaultSessionId(): string {
  return `pane-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

function pagesFrom(event: Record<string, unknown>): {
  pages: BrowserPageSummary[]
  activePageId: string | null
} | null {
  if (!Array.isArray(event.pages)) return null
  const pages = event.pages as BrowserPageSummary[]
  const activePageId =
    typeof event.activePageId === "string"
      ? event.activePageId
      : (pages.find((page) => page.active)?.id ?? null)
  return { pages, activePageId }
}

export function useLocalBrowserSession({
  backend,
  userChromeBrowser,
  initialUrl,
  onFrame,
  createSessionId = defaultSessionId,
}: UseLocalBrowserSessionOptions): LocalBrowserSession {
  const [state, setState] = useState<LocalSessionState>("starting")
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [engine, setEngine] = useState<LocalChromiumEngine | null>(null)
  const [pages, setPages] = useState<BrowserPageSummary[]>([])
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<LocalBrowserDialog | null>(null)
  /** Bumped by `restart` and by adopting an agent session. */
  const [generation, setGeneration] = useState(0)
  /** A session to show instead of creating one (an adopted agent session). */
  const adoptRef = useRef<string | null>(null)
  const onFrameRef = useRef(onFrame)
  const initialUrlRef = useRef(initialUrl)
  const createIdRef = useRef(createSessionId)
  const sessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  useEffect(() => {
    let disposed = false
    let unsubscribeFrames: (() => void) | null = null
    let unlistenEvents: (() => void) | null = null
    let createdId: string | null = null
    const adopted = adoptRef.current
    adoptRef.current = null

    const handleEvent = (event: LocalBrowserEvent) => {
      if (disposed || event.sessionId !== createdId) return
      if (event.type === "pages.changed") {
        const next = pagesFrom(event)
        if (next) {
          setPages(next.pages)
          setActivePageId(next.activePageId)
        }
      } else if (event.type === "dialog.opened") {
        const payload = (event.dialog ?? event) as Partial<LocalBrowserDialog>
        setDialog({
          type:
            typeof payload.type === "string" && payload.type !== "dialog.opened"
              ? payload.type
              : "alert",
          message: typeof payload.message === "string" ? payload.message : "",
          ...(typeof payload.defaultValue === "string"
            ? { defaultValue: payload.defaultValue }
            : {}),
        })
      } else if (event.type === "session.closed") {
        setState("closed")
        configureLocalBrowserEngine(null)
      }
    }

    const setup = async () => {
      try {
        unlistenEvents = await localBrowser.onEvent(handleEvent)
        if (disposed) return
        if (adopted) {
          createdId = adopted
        } else {
          const requestedId = createIdRef.current()
          const created = await localBrowser.createSession({
            id: requestedId,
            kind: backend === "user-chrome" ? "user-chrome" : "local",
            headless: true,
            allowFileUrls: true,
            ...(backend === "user-chrome" && userChromeBrowser
              ? { browser: userChromeBrowser }
              : {}),
          })
          createdId = created?.id ?? requestedId
        }
        if (disposed) {
          void localBrowser.closeSession(createdId).catch(() => undefined)
          return
        }
        sessionIdRef.current = createdId
        const nextEngine = new LocalChromiumEngine(createdId, backend)
        configureLocalBrowserEngine({ sessionId: createdId, backend })
        setSessionId(createdId)
        setEngine(nextEngine)
        unsubscribeFrames = await localBrowser.subscribeFrames(createdId, (bytes) =>
          onFrameRef.current(bytes)
        )
        if (disposed) {
          unsubscribeFrames()
          return
        }
        const firstUrl = initialUrlRef.current
        if (firstUrl && !adopted) await nextEngine.navigate(firstUrl)
        const currentPages = await nextEngine.listPages()
        if (disposed) return
        setPages(currentPages)
        setActivePageId(currentPages.find((page) => page.active)?.id ?? null)
        setState("ready")
      } catch (cause) {
        if (disposed) return
        setError(errorCode(cause))
        setState("failed")
      }
    }

    void setup()
    return () => {
      disposed = true
      unsubscribeFrames?.()
      unlistenEvents?.()
      configureLocalBrowserEngine(null)
      const closing = createdId
      sessionIdRef.current = null
      setEngine(null)
      setSessionId(null)
      if (!closing) return
      // The user's own Chrome keeps every tab it had; only the ones this
      // session opened are closed (`finalize`) before it detaches.
      const finalize =
        backend === "user-chrome"
          ? localBrowser.rpc("browser.tabs.finalize", { sessionId: closing }).catch(() => undefined)
          : Promise.resolve()
      void finalize.then(() => localBrowser.closeSession(closing)).catch(() => undefined)
    }
  }, [backend, userChromeBrowser, generation])

  /** Start over: a fresh session (or the adopted one) replaces whatever ran. */
  const beginGeneration = useCallback(() => {
    setState("starting")
    setError(null)
    setPages([])
    setActivePageId(null)
    setDialog(null)
    setGeneration((value) => value + 1)
  }, [])

  // Adopt the agent's own session for this backend when it announces one.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onAgentSession = (event: Event) => {
      const detail = (event as CustomEvent<BrowserAgentLocalSession>).detail
      if (!detail || detail.backend !== backend) return
      if (detail.sessionId === sessionIdRef.current) return
      adoptRef.current = detail.sessionId
      beginGeneration()
    }
    window.addEventListener(BROWSER_AGENT_LOCAL_SESSION_EVENT, onAgentSession)
    return () => window.removeEventListener(BROWSER_AGENT_LOCAL_SESSION_EVENT, onAgentSession)
  }, [backend, beginGeneration])

  const refreshPages = useCallback(async () => {
    if (!engine) return
    const next = await engine.listPages()
    setPages(next)
    setActivePageId(next.find((page) => page.active)?.id ?? null)
  }, [engine])

  const dismissDialog = useCallback(() => setDialog(null), [])
  const restart = beginGeneration

  return {
    state,
    error,
    sessionId,
    engine,
    pages,
    activePageId,
    dialog,
    dismissDialog,
    refreshPages,
    restart,
  }
}
