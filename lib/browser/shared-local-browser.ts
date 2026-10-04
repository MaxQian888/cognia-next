/**
 * The desktop's one local-Chromium session, shared by everything that shows or
 * drives a page in Cognia's own Chromium (ADR-0214; ADR-0201).
 *
 * Why one: every local session opens the `default` profile, and the runtime
 * lets one session hold a profile at a time. Two panes (or a pane and an
 * agent) each creating a session meant the second failed with
 * `browser_profile_in_use` — and the profile is where the user's sign-ins,
 * cookies and extensions live, so a second profile would not be the same
 * browser anyway. The session is created lazily, the first time anything needs
 * a page, and outlives every pane that shows it.
 *
 * What is split instead is the pages. Every page has an OWNER:
 *
 * - `chat:<sessionId>` — a conversation's page tabs in the dock, and the pages
 *   that conversation's agent drives;
 * - `pane:<id>` — a browser pane outside the dock (`/browser`, site publish);
 * - `agent:<id>` — an agent with no conversation on screen to show it in.
 *
 * Each owner's operations address its own pages (`pageId` on every runtime op,
 * see `LocalChromiumEngine`), so a background task's agent keeps working on its
 * page while the user looks at another. Only the screen decides which page is
 * in front: the pane that is showing activates its page, and the screencast
 * follows.
 *
 * A page nobody claimed — a popup, a link a page opened in a new tab — goes to
 * the owner of the page that opened it, else to the owner of the page that was
 * in front when it appeared. The blank page a new session starts with stays
 * unowned until the first owner that needs a page takes it.
 */

import { createStore } from "zustand/vanilla"

import { localBrowser, type LocalBrowserEvent } from "@/lib/browser/local-client"
import {
  isLocalSessionCredentialFilled,
  LocalChromiumEngine,
  toLocalBrowserError,
} from "@/lib/browser/local-chromium-engine"
import { BrowserSessionError, type BrowserPageSummary } from "@/lib/browser/session-types"
import type { BrowserEngine } from "@/lib/browser/agent-engine"

/** A native `alert` / `confirm` / `prompt` / `beforeunload` holding a page. */
export interface LocalBrowserDialog {
  type: string
  message: string
  defaultValue?: string
}

export type SharedBrowserStatus = "idle" | "starting" | "ready" | "failed"

export interface OwnedPage {
  owner: string
  /**
   * What the owner calls this page — the dock's page-tab id. `null` for a page
   * nobody has put a tab on yet (one an agent or a page opened).
   */
  tag: string | null
}

export interface SharedLocalBrowserState {
  sessionId: string | null
  status: SharedBrowserStatus
  /** The runtime's error code when the session could not be created. */
  error: string | null
  /** Every page in the session, in the runtime's order. */
  pages: BrowserPageSummary[]
  /** The page in front: what the screencast shows. */
  activePageId: string | null
  owned: Record<string, OwnedPage>
  /** Owner → the page its agent acts on. */
  focus: Record<string, string>
  /** Page → the dialog holding it. */
  dialogs: Record<string, LocalBrowserDialog>
}

/** One owner may keep this many pages; the runtime's own cap is 32 for everyone. */
export const MAX_PAGES_PER_OWNER = 8

/** A session with no owned page and nobody watching closes after this long. */
export const SHARED_BROWSER_IDLE_CLOSE_MS = 60_000

const INITIAL: SharedLocalBrowserState = {
  sessionId: null,
  status: "idle",
  error: null,
  pages: [],
  activePageId: null,
  owned: {},
  focus: {},
  dialogs: {},
}

export const sharedLocalBrowserStore = createStore<SharedLocalBrowserState>(() => INITIAL)

export function chatPageOwner(chatSessionId: string): string {
  return `chat:${chatSessionId}`
}

/** The conversation behind a `chat:` owner, or null for any other owner. */
export function chatSessionOfOwner(owner: string): string | null {
  return owner.startsWith("chat:") ? owner.slice("chat:".length) : null
}

let starting: Promise<string> | null = null
let unlistenEvents: (() => void) | null = null
let listening: Promise<void> | null = null
/** `browser.page.create` calls in flight: their page must not be adopted as a stray. */
let pendingCreates = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

const frameListeners = new Set<(bytes: Uint8Array) => void>()
let frameSubscription: { sessionId: string; unsubscribe: () => void } | null = null
let frameSync: Promise<void> = Promise.resolve()

function errorCode(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "browser_local_unavailable"
}

function defaultSessionId(): string {
  return `shared-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

let createSessionId = defaultSessionId

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

/**
 * Fold a fresh page list in: forget pages that are gone, keep each owner's
 * focus on a page it still has, and hand strays to an owner.
 */
function applyPages(pages: BrowserPageSummary[], activePageId: string | null): void {
  const previous = sharedLocalBrowserStore.getState()
  const alive = new Set(pages.map((page) => page.id))
  const owned: Record<string, OwnedPage> = {}
  for (const [pageId, entry] of Object.entries(previous.owned)) {
    if (alive.has(pageId)) owned[pageId] = entry
  }
  if (pendingCreates === 0) {
    for (const page of pages) {
      if (owned[page.id]) continue
      const owner =
        (page.openerId ? owned[page.openerId]?.owner : undefined) ??
        (previous.activePageId && previous.activePageId !== page.id
          ? owned[previous.activePageId]?.owner
          : undefined)
      if (owner) owned[page.id] = { owner, tag: null }
    }
  }
  const focus: Record<string, string> = {}
  for (const [owner, pageId] of Object.entries(previous.focus)) {
    if (owned[pageId]?.owner === owner) {
      focus[owner] = pageId
      continue
    }
    const fallback = pages.findLast((page) => owned[page.id]?.owner === owner)
    if (fallback) focus[owner] = fallback.id
  }
  const dialogs: Record<string, LocalBrowserDialog> = {}
  for (const [pageId, dialog] of Object.entries(previous.dialogs)) {
    if (alive.has(pageId)) dialogs[pageId] = dialog
  }
  sharedLocalBrowserStore.setState({ pages, activePageId, owned, focus, dialogs })
  scheduleIdleClose()
  void syncFrames()
}

function reset(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  sharedLocalBrowserStore.setState({ ...INITIAL })
  void syncFrames()
}

function handleEvent(event: LocalBrowserEvent): void {
  const { sessionId } = sharedLocalBrowserStore.getState()
  if (!sessionId || event.sessionId !== sessionId) return
  if (event.type === "pages.changed") {
    const next = pagesFrom(event)
    if (next) applyPages(next.pages, next.activePageId)
  } else if (event.type === "dialog.opened") {
    const pageId = typeof event.pageId === "string" ? event.pageId : null
    if (!pageId) return
    const payload = (event.dialog ?? event) as Partial<LocalBrowserDialog>
    const dialog: LocalBrowserDialog = {
      type:
        typeof payload.type === "string" && payload.type !== "dialog.opened"
          ? payload.type
          : "alert",
      message: typeof payload.message === "string" ? payload.message : "",
      ...(typeof payload.defaultValue === "string" ? { defaultValue: payload.defaultValue } : {}),
    }
    sharedLocalBrowserStore.setState((state) => ({
      dialogs: { ...state.dialogs, [pageId]: dialog },
    }))
  } else if (event.type === "session.closed") {
    // The runtime closed it (idle reaper, Chromium gone): every page went with
    // it. Owners keep what they remember and open pages again on demand.
    reset()
  }
}

function ensureListening(): Promise<void> {
  if (unlistenEvents) return Promise.resolve()
  listening ??= localBrowser
    .onEvent(handleEvent)
    .then((unlisten) => {
      unlistenEvents = unlisten
    })
    .finally(() => {
      listening = null
    })
  return listening
}

/** Read the page list now, rather than waiting for the next `pages.changed`. */
export async function refreshSharedPages(): Promise<BrowserPageSummary[]> {
  const { sessionId } = sharedLocalBrowserStore.getState()
  if (!sessionId) return []
  const pages = await localBrowser.rpc<BrowserPageSummary[]>("browser.pages", { sessionId })
  applyPages(pages, pages.find((page) => page.active)?.id ?? null)
  return pages
}

/**
 * The shared session's id, creating the session (and starting the runtime)
 * on first use. Concurrent callers share one creation.
 */
export function ensureSharedLocalBrowser(): Promise<string> {
  const current = sharedLocalBrowserStore.getState()
  if (current.sessionId && current.status === "ready") return Promise.resolve(current.sessionId)
  if (starting) return starting
  starting = (async () => {
    sharedLocalBrowserStore.setState({ status: "starting", error: null })
    try {
      await ensureListening()
      const requested = createSessionId()
      const created = await localBrowser.createSession({
        id: requested,
        kind: "local",
        headless: true,
        allowFileUrls: true,
      })
      const sessionId = created?.id ?? requested
      sharedLocalBrowserStore.setState({ sessionId, status: "ready" })
      await refreshSharedPages()
      return sessionId
    } catch (error) {
      sharedLocalBrowserStore.setState({ ...INITIAL, status: "failed", error: errorCode(error) })
      throw toLocalBrowserError(error)
    } finally {
      starting = null
    }
  })()
  return starting
}

/** The pages `owner` holds, in the runtime's order. */
export function ownerPages(owner: string): BrowserPageSummary[] {
  const { pages, owned } = sharedLocalBrowserStore.getState()
  return pages.filter((page) => owned[page.id]?.owner === owner)
}

/** The page `owner` put behind `tag`, if it is still open. */
export function taggedPage(owner: string, tag: string): BrowserPageSummary | null {
  const { pages, owned } = sharedLocalBrowserStore.getState()
  return pages.find((page) => owned[page.id]?.owner === owner && owned[page.id].tag === tag) ?? null
}

/** Give `pageId` to `owner` (under `tag`), and make it the owner's focus. */
export function assignSharedPage(pageId: string, owner: string, tag: string | null): void {
  sharedLocalBrowserStore.setState((state) => ({
    owned: { ...state.owned, [pageId]: { owner, tag } },
    focus: { ...state.focus, [owner]: pageId },
  }))
  scheduleIdleClose()
}

/** Re-label a page an owner already holds (a tab adopting an agent's page). */
export function tagSharedPage(pageId: string, tag: string | null): void {
  sharedLocalBrowserStore.setState((state) => {
    const entry = state.owned[pageId]
    if (!entry || entry.tag === tag) return state
    return { owned: { ...state.owned, [pageId]: { ...entry, tag } } }
  })
}

/** Point `owner`'s agent at one of its pages. */
export function setOwnerFocus(owner: string, pageId: string): void {
  const { owned, focus } = sharedLocalBrowserStore.getState()
  if (owned[pageId]?.owner !== owner) {
    throw new BrowserSessionError("browser_page_not_found", "That page belongs to another task")
  }
  if (focus[owner] === pageId) return
  sharedLocalBrowserStore.setState((state) => ({ focus: { ...state.focus, [owner]: pageId } }))
}

function rpc<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  return localBrowser.rpc<T>(op, payload).catch((error: unknown) => {
    throw toLocalBrowserError(error)
  })
}

/**
 * Open a page for `owner`. `activate` puts it in front (a pane showing it);
 * otherwise it opens behind whatever the user is looking at. The page opens
 * blank — navigate it with {@link sharedPageEngine} — so a page that fails to
 * load is still a tab the owner can see and close.
 */
export async function openOwnedPage(
  owner: string,
  options: { activate?: boolean; tag?: string | null } = {}
): Promise<BrowserPageSummary> {
  if (ownerPages(owner).length >= MAX_PAGES_PER_OWNER) {
    throw new BrowserSessionError(
      "browser_page_quota_exceeded",
      `This task already has ${MAX_PAGES_PER_OWNER} pages open. Close one first.`
    )
  }
  const sessionId = await ensureSharedLocalBrowser()
  const tag = options.tag ?? null
  pendingCreates += 1
  try {
    const { pages, owned } = sharedLocalBrowserStore.getState()
    // The blank page a session starts with, before anyone has used it.
    const spare = pages.find((page) => !owned[page.id] && page.url === "about:blank")
    let page: BrowserPageSummary
    if (spare) {
      assignSharedPage(spare.id, owner, tag)
      if (options.activate) await activateSharedPage(spare.id)
      page = { ...spare, active: options.activate === true || spare.active }
    } else {
      const created = await rpc<BrowserPageSummary>("browser.page.create", {
        sessionId,
        ...(options.activate ? {} : { activate: false }),
      })
      // Listed now rather than on the debounced `pages.changed`: until then a
      // pane looking for its tag would find nothing and open a second page.
      sharedLocalBrowserStore.setState((state) =>
        state.pages.some((existing) => existing.id === created.id)
          ? state
          : {
              pages: [...state.pages, created],
              ...(created.active ? { activePageId: created.id } : {}),
            }
      )
      assignSharedPage(created.id, owner, tag)
      page = created
    }
    return page
  } finally {
    pendingCreates -= 1
    if (pendingCreates === 0) {
      const { pages, activePageId } = sharedLocalBrowserStore.getState()
      applyPages(pages, activePageId)
    }
  }
}

const taggedCreates = new Map<string, Promise<BrowserPageSummary>>()

/**
 * The page `owner` keeps behind `tag`, opening it when there is none. One
 * creation per tag at a time: the pane showing a tab and an agent reaching for
 * the same tab must not each open a page.
 */
export async function ensureTaggedPage(
  owner: string,
  tag: string,
  options: { activate?: boolean } = {}
): Promise<{ page: BrowserPageSummary; created: boolean }> {
  await ensureSharedLocalBrowser()
  const existing = taggedPage(owner, tag)
  if (existing) return { page: existing, created: false }
  const key = `${owner}\u0000${tag}`
  const pending = taggedCreates.get(key)
  if (pending) return { page: await pending, created: false }
  const creating = openOwnedPage(owner, { tag, activate: options.activate })
  taggedCreates.set(key, creating)
  try {
    return { page: await creating, created: true }
  } finally {
    taggedCreates.delete(key)
  }
}

/**
 * Where an owner's agent should open its first page: the tab the owner is
 * showing, when it has no page yet (a tab restored from memory). Wired by the
 * dock (`startDockPageSync`); unwired, the agent opens a page of its own.
 */
let focusTagResolver: (owner: string) => string | null = () => null

export function setFocusPageTagResolver(resolver: ((owner: string) => string | null) | null) {
  focusTagResolver = resolver ?? (() => null)
}

/** Bring `pageId` to the front: the screencast follows. */
export async function activateSharedPage(pageId: string): Promise<void> {
  const { sessionId } = sharedLocalBrowserStore.getState()
  if (!sessionId) return
  await rpc("browser.page.activate", { sessionId, pageId })
  sharedLocalBrowserStore.setState((state) =>
    state.activePageId === pageId ? state : { activePageId: pageId }
  )
}

export async function closeSharedPage(pageId: string): Promise<void> {
  const { sessionId } = sharedLocalBrowserStore.getState()
  if (!sessionId) return
  await rpc("browser.page.close", { sessionId, pageId })
}

/**
 * Close every page `owner` holds. The session stays: other owners keep theirs,
 * and closing it would only make the next page slower.
 */
export async function releaseOwner(owner: string): Promise<void> {
  const pageIds = ownerPages(owner).map((page) => page.id)
  sharedLocalBrowserStore.setState((state) => {
    if (!(owner in state.focus)) return state
    const focus = { ...state.focus }
    delete focus[owner]
    return { focus }
  })
  await Promise.allSettled(pageIds.map((pageId) => closeSharedPage(pageId)))
}

/** Answer the dialog holding `pageId` and forget it. */
export async function answerSharedDialog(
  pageId: string,
  answer: { accept: boolean; promptText?: string }
): Promise<void> {
  sharedLocalBrowserStore.setState((state) => {
    if (!(pageId in state.dialogs)) return state
    const dialogs = { ...state.dialogs }
    delete dialogs[pageId]
    return { dialogs }
  })
  const engine = sharedPageEngine(pageId)
  if (engine) await engine.handleDialog(answer)
}

/** An engine that acts on `pageId`, or null while there is no session. */
export function sharedPageEngine(pageId: string): LocalChromiumEngine | null {
  const { sessionId } = sharedLocalBrowserStore.getState()
  return sessionId ? new LocalChromiumEngine(sessionId, "local-chromium", { pageId }) : null
}

/**
 * The page `owner`'s agent acts on: its focus, else the last page it holds,
 * else a new one opened behind the page in front.
 */
export async function ensureOwnerFocusPage(owner: string): Promise<string> {
  await ensureSharedLocalBrowser()
  const { focus, owned } = sharedLocalBrowserStore.getState()
  const current = focus[owner]
  if (current && owned[current]?.owner === owner) return current
  const last = ownerPages(owner).at(-1)
  if (last) {
    setOwnerFocus(owner, last.id)
    return last.id
  }
  const tag = focusTagResolver(owner)
  if (tag) {
    const { page } = await ensureTaggedPage(owner, tag, { activate: false })
    setOwnerFocus(owner, page.id)
    return page.id
  }
  return (await openOwnedPage(owner, { activate: false })).id
}

/**
 * A `BrowserEngine` that acts for `owner`: every call goes to the owner's focus
 * page (opened on first use), and the page operations see only the owner's
 * pages — an agent lists, switches and closes its own tabs, never another
 * task's, and switching moves its focus rather than the page the user sees.
 */
export function ownedPageEngine(owner: string): BrowserEngine {
  const ownPage = (pageId: string) => {
    if (sharedLocalBrowserStore.getState().owned[pageId]?.owner !== owner) {
      throw new BrowserSessionError("browser_page_not_found", "Page not found")
    }
  }
  const pageList = (): BrowserPageSummary[] => {
    const focused = sharedLocalBrowserStore.getState().focus[owner]
    return ownerPages(owner).map((page) => ({ ...page, active: page.id === focused }))
  }
  const special: Record<string, (...args: never[]) => unknown> = {
    listPages: async () => {
      await ensureSharedLocalBrowser()
      await refreshSharedPages()
      return pageList()
    },
    activatePage: async (pageId: string) => {
      await ensureSharedLocalBrowser()
      ownPage(pageId)
      setOwnerFocus(owner, pageId)
    },
    closePage: async (pageId: string) => {
      ownPage(pageId)
      await closeSharedPage(pageId)
    },
    createPage: async (url?: string) => {
      const page = await openOwnedPage(owner, { activate: false })
      if (url && url !== "about:blank") await sharedPageEngine(page.id)?.navigate(url)
      return { ...page, url: url ?? page.url, active: true }
    },
  }
  return new Proxy({} as BrowserEngine, {
    get(_target, property) {
      if (property === "backend") return "local-chromium"
      if (property === "then") return undefined
      if (property === "sessionId") return sharedLocalBrowserStore.getState().sessionId
      if (property === "credentialFilled") {
        const { sessionId } = sharedLocalBrowserStore.getState()
        return sessionId ? isLocalSessionCredentialFilled(sessionId) : false
      }
      if (typeof property === "string" && property in special) return special[property]
      return async (...args: unknown[]) => {
        const pageId = await ensureOwnerFocusPage(owner)
        const engine = sharedPageEngine(pageId)
        if (!engine) throw new BrowserSessionError("browser_session_not_found", "No session")
        const method = (engine as unknown as Record<PropertyKey, unknown>)[property]
        if (typeof method !== "function") {
          throw new TypeError(`BrowserEngine has no method ${String(property)}`)
        }
        return (method as (...a: unknown[]) => unknown).apply(engine, args)
      }
    },
  })
}

/**
 * Receive the screencast of whatever page is in front. One Rust subscription
 * serves every listener: a second `browser_local_frames_subscribe` for the
 * same session would replace the first.
 */
export function subscribeSharedFrames(listener: (bytes: Uint8Array) => void): () => void {
  frameListeners.add(listener)
  void syncFrames()
  scheduleIdleClose()
  return () => {
    frameListeners.delete(listener)
    void syncFrames()
    scheduleIdleClose()
  }
}

function syncFrames(): Promise<void> {
  frameSync = frameSync.then(async () => {
    const { sessionId, activePageId } = sharedLocalBrowserStore.getState()
    const wanted = frameListeners.size > 0 && sessionId && activePageId ? sessionId : null
    if (frameSubscription && frameSubscription.sessionId !== wanted) {
      frameSubscription.unsubscribe()
      frameSubscription = null
    }
    if (!wanted || frameSubscription) return
    try {
      const unsubscribe = await localBrowser.subscribeFrames(wanted, (bytes) => {
        for (const receive of frameListeners) receive(bytes)
      })
      frameSubscription = { sessionId: wanted, unsubscribe }
    } catch {
      // No page in front yet, or the runtime went away: the next page list
      // or listener retries.
    }
  })
  return frameSync
}

/**
 * Close the session once nothing holds a page and nobody is watching, so an
 * idle Chromium does not run for the rest of the day.
 */
function scheduleIdleClose(): void {
  const { sessionId, owned } = sharedLocalBrowserStore.getState()
  const idle = !!sessionId && Object.keys(owned).length === 0 && frameListeners.size === 0
  if (!idle) {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    return
  }
  if (idleTimer) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    const state = sharedLocalBrowserStore.getState()
    if (
      state.sessionId !== sessionId ||
      Object.keys(state.owned).length > 0 ||
      frameListeners.size > 0 ||
      starting
    ) {
      return
    }
    reset()
    void localBrowser.closeSession(sessionId).catch(() => undefined)
  }, SHARED_BROWSER_IDLE_CLOSE_MS)
}

/** Test seam: forget the session and every listener without touching the runtime. */
export function resetSharedLocalBrowserForTests(options: { createSessionId?: () => string } = {}) {
  unlistenEvents?.()
  unlistenEvents = null
  listening = null
  starting = null
  pendingCreates = 0
  frameListeners.clear()
  frameSubscription = null
  frameSync = Promise.resolve()
  taggedCreates.clear()
  focusTagResolver = () => null
  createSessionId = options.createSessionId ?? defaultSessionId
  reset()
}
