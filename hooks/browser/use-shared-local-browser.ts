"use client"

/**
 * A browser pane's view onto the desktop's one local-Chromium session
 * (`lib/browser/shared-local-browser.ts`, ADR-0214).
 *
 * The session is shared and outlives the pane; what the pane holds is a set of
 * pages under one OWNER:
 *
 * - a dock page tab passes `tag` (the tab's id) and shows the one page behind
 *   that tab, opening it at the tab's address when there is none — the lazy
 *   restore of a task's page after it was closed in the background;
 * - any other pane gets an owner of its own, shows that owner's pages with its
 *   own tab row, and closes them when it unmounts.
 *
 * Whatever page the pane shows it puts in front (the screencast follows) and
 * makes its owner's focus, so the conversation's agent acts on the page the
 * user is looking at. Returns the same shape as `useLocalBrowserSession`, so
 * one pane body serves both this and the user's own Chrome.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "zustand"

import {
  activateSharedPage,
  answerSharedDialog,
  closeSharedPage,
  ensureSharedLocalBrowser,
  ensureTaggedPage,
  openOwnedPage,
  refreshSharedPages,
  releaseOwner,
  setOwnerFocus,
  sharedLocalBrowserStore,
  sharedPageEngine,
  subscribeSharedFrames,
  type LocalBrowserDialog,
} from "@/lib/browser/shared-local-browser"
import type { BrowserPageSummary } from "@/lib/browser/session-types"
import type { LocalChromiumEngine } from "@/lib/browser/local-chromium-engine"
import type { LocalSessionState } from "@/hooks/browser/use-local-browser-session"

export interface UseSharedLocalBrowserOptions {
  owner: string
  /** Show the owner's page behind this tag (a dock page tab). */
  tag?: string
  /** Where a page opened for this pane goes first. */
  initialUrl?: string
  onFrame: (bytes: Uint8Array) => void
}

export interface SharedLocalBrowserPane {
  state: LocalSessionState
  error: string | null
  sessionId: string | null
  /** An engine on the page shown. */
  engine: LocalChromiumEngine | null
  /** The pages this pane can switch between: the owner's, or the tagged one. */
  pages: BrowserPageSummary[]
  activePageId: string | null
  dialog: LocalBrowserDialog | null
  dismissDialog: () => void
  answerDialog: (answer: { accept: boolean; promptText?: string }) => Promise<void>
  refreshPages: () => Promise<void>
  restart: () => void
  /** True while a remembered page is being opened again. */
  restoring: boolean
  selectPage: (pageId: string) => void
  createPage: () => Promise<void>
  closePage: (pageId: string) => Promise<void>
}

/**
 * The tag of an untagged pane's first page. Opening it through
 * `ensureTaggedPage` makes it one page however often the effect runs.
 */
const PANE_FIRST_PAGE_TAG = "pane-first"

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code
  }
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "browser_local_unavailable"
}

export function useSharedLocalBrowser({
  owner,
  tag,
  initialUrl,
  onFrame,
}: UseSharedLocalBrowserOptions): SharedLocalBrowserPane {
  const sessionId = useStore(sharedLocalBrowserStore, (state) => state.sessionId)
  const status = useStore(sharedLocalBrowserStore, (state) => state.status)
  const sessionError = useStore(sharedLocalBrowserStore, (state) => state.error)
  const allPages = useStore(sharedLocalBrowserStore, (state) => state.pages)
  const owned = useStore(sharedLocalBrowserStore, (state) => state.owned)
  const focusPageId = useStore(sharedLocalBrowserStore, (state) => state.focus[owner] ?? null)
  const dialogs = useStore(sharedLocalBrowserStore, (state) => state.dialogs)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [generation, setGeneration] = useState(0)
  /** The page the user picked in this pane's own tab row (untagged panes). */
  const [picked, setPicked] = useState<string | null>(null)
  const onFrameRef = useRef(onFrame)
  const initialUrlRef = useRef(initialUrl)
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  const pages = useMemo(
    () =>
      allPages.filter(
        (page) => owned[page.id]?.owner === owner && (!tag || owned[page.id].tag === tag)
      ),
    [allPages, owned, owner, tag]
  )
  const shownPageId =
    (tag
      ? pages[0]?.id
      : (pages.find((page) => page.id === picked)?.id ??
        pages.find((page) => page.id === focusPageId)?.id ??
        pages.at(-1)?.id)) ?? null

  // The screencast, for as long as the pane is up.
  useEffect(() => subscribeSharedFrames((bytes) => onFrameRef.current(bytes)), [])

  // Have a page to show: the tagged one (opened at the tab's address when the
  // task's page was closed), or a first page of this pane's own.
  // One opening at a time per owner, tag and restart. Not cancelled when the
  // page it opens appears (that is what ends the need for it): only an
  // unmounted pane stops caring about the result.
  const hasPage = pages.length > 0
  const mountedRef = useRef(true)
  const openingRef = useRef<string | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (hasPage) return
    const key = `${owner}\u0000${tag ?? ""}\u0000${generation}`
    if (openingRef.current === key) return
    openingRef.current = key
    const open = async () => {
      try {
        setError(null)
        const url = initialUrlRef.current
        const result = await ensureTaggedPage(owner, tag ?? PANE_FIRST_PAGE_TAG, {
          activate: true,
        })
        if (!mountedRef.current || !result.created || !url || url === "about:blank") return
        setRestoring(true)
        await sharedPageEngine(result.page.id)?.navigate(url)
      } catch (cause) {
        if (mountedRef.current) setError(errorCode(cause))
      } finally {
        if (openingRef.current === key) openingRef.current = null
        if (mountedRef.current) setRestoring(false)
      }
    }
    void open()
  }, [hasPage, owner, tag, generation])

  // The page shown is the page in front, and the one the owner's agent acts on.
  useEffect(() => {
    if (!shownPageId) return
    void activateSharedPage(shownPageId).catch(() => undefined)
    try {
      setOwnerFocus(owner, shownPageId)
    } catch {
      // Gone between render and effect: the next page list settles it.
    }
  }, [shownPageId, owner])

  // A pane outside the dock takes its pages with it.
  useEffect(
    () => () => {
      if (!tag) void releaseOwner(owner)
    },
    [owner, tag]
  )

  // `sessionId` is a dependency so a new session re-creates the engine.
  const engine = useMemo(
    () => (sessionId && shownPageId ? sharedPageEngine(shownPageId) : null),
    [sessionId, shownPageId]
  )

  const state: LocalSessionState =
    error || status === "failed"
      ? "failed"
      : status === "ready" && engine && !restoring
        ? "ready"
        : "starting"

  const refreshPages = useCallback(async () => {
    await refreshSharedPages()
  }, [])

  const restart = useCallback(() => {
    setError(null)
    setGeneration((value) => value + 1)
    void ensureSharedLocalBrowser().catch((cause: unknown) => setError(errorCode(cause)))
  }, [])

  const answerDialog = useCallback(
    async (answer: { accept: boolean; promptText?: string }) => {
      if (shownPageId) await answerSharedDialog(shownPageId, answer)
    },
    [shownPageId]
  )

  const dismissDialog = useCallback(() => {
    if (!shownPageId) return
    sharedLocalBrowserStore.setState((current) => {
      if (!(shownPageId in current.dialogs)) return current
      const next = { ...current.dialogs }
      delete next[shownPageId]
      return { dialogs: next }
    })
  }, [shownPageId])

  const createPage = useCallback(async () => {
    const page = await openOwnedPage(owner, { activate: true })
    setPicked(page.id)
  }, [owner])

  const closePage = useCallback(async (pageId: string) => {
    await closeSharedPage(pageId)
  }, [])

  return {
    state,
    error: error ?? sessionError,
    sessionId,
    engine,
    pages: pages.map((page) => ({ ...page, active: page.id === shownPageId })),
    activePageId: shownPageId,
    dialog: shownPageId ? (dialogs[shownPageId] ?? null) : null,
    dismissDialog,
    answerDialog,
    refreshPages,
    restart,
    restoring,
    selectPage: setPicked,
    createPage,
    closePage,
  }
}
