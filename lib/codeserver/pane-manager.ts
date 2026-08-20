/**
 * Sole owner of the `codeserver-embed` native webview.
 *
 * There is exactly ONE such webview per app (`CODESERVER_EMBED_LABEL` in
 * `src-tauri/src/codeserver/webview.rs`), but two React surfaces can host a Pro
 * IDE pane — the Agent Team Editor tab and the chat-side workspace dock. Letting
 * each surface call `codeServerClient.embed*` directly makes them fight over one
 * native resource, and — worse — makes an unmount destroy a webview the other
 * surface is about to reuse.
 *
 * So ownership lives here instead of in React:
 *
 *  - a surface `claim`s the pane with an owner id; claiming away from another
 *    owner revokes it (the loser falls back to Monaco);
 *  - `release` (unmount, tab switch, route change) only drops ownership and
 *    parks the webview off-screen — it does NOT destroy it, so VS Code keeps its
 *    open editors, cursor, and terminals across navigation;
 *  - `destroy` is reserved for an explicit stop / app teardown.
 *
 * Every native round-trip is serialized through one promise chain: create,
 * navigate and set_bounds against a single webview must not interleave, or a
 * late `create` can resurrect a webview a concurrent `release` just parked.
 *
 * Because ownership already answers "which Pro IDE is live", this module is also
 * where the *bound project root* lives — see {@link getActiveProIdeRoot}. That
 * root is what every headless caller (workflow nodes, agent tools, plan steps,
 * issue runs) resolves against when it was not handed an explicit one.
 */
import type { ElementRect } from "@/lib/browser/protocol"
import { codeServerClient } from "@/lib/codeserver/client"
import { isTauri } from "@/lib/tauri"

/** Off-screen park position — mirrors `codeserver_embed_set_visible`'s hide. */
const PARKED_RECT: ElementRect = { x: -32000, y: -32000, width: 0, height: 0 }

/**
 * Root marker set while some surface holds the pane, valued with the owning
 * surface's id. `app/globals.css` uses it to collapse the app-shell transitions
 * the native webview sits inside — see {@link reflectActive}.
 */
const ACTIVE_ATTR = "data-pro-ide-active"

/**
 * Marker a hosting surface puts on the reserved `<div>` the native webview is
 * pinned over, so an animating ancestor can ask "is a live Pro IDE pane inside
 * the box I am about to tween?" without knowing anything about owner ids.
 */
export const PRO_IDE_REGION_ATTR = "data-pro-ide-region"

interface Owner {
  id: string
  /** Called when another surface claims the pane away from this owner. */
  onRevoked: () => void
}

/** Everything a hosting surface must hand over to take the pane. */
export interface CodeServerPaneClaim {
  /** Stable id identifying the claiming surface. */
  ownerId: string
  /**
   * Canonical project root the code-server behind this pane is serving.
   *
   * Carried through the claim rather than set separately so it can never drift
   * from `url`: the two describe one instance, and a root that disagrees with
   * the port the pane is pointed at would silently drive the wrong workspace.
   */
  root: string
  /** Loopback url of the code-server serving {@link root}. */
  url: string
  rect: ElementRect
  /** Called when another surface claims the pane away from this owner. */
  onRevoked: () => void
}

let owner: Owner | null = null
/**
 * Project root of the last-claimed pane — the "bound Pro IDE" every headless
 * caller resolves against.
 *
 * Deliberately NOT part of {@link owner}: `release` drops ownership but only
 * *parks* the webview, and the code-server behind it keeps running and keeps
 * serving this root. A workflow step that fires while the user is on another
 * route must still resolve to it, so the binding outlives ownership and is
 * cleared only by `destroy`, which is the one path that actually ends the
 * instance.
 */
let boundRoot: string | null = null
let created = false
let mountedUrl: string | null = null
let lastRect: ElementRect | null = null
let visible = true
let queue: Promise<unknown> = Promise.resolve()
/**
 * Last background the pane webview was painted in (`#RRGGBB`).
 *
 * Held here rather than passed per-call because the webview outlives every
 * hosting surface: a `claim` that happens *before* the appearance sync has run
 * must still create the webview in the app colour, and a theme flip while no
 * surface is mounted must still be remembered for the next create.
 */
let backgroundHex: string | null = null

/**
 * Publish "a surface is hosting Pro IDE" to CSS.
 *
 * The native webview floats above the DOM and its bounds are re-pushed over IPC
 * about once per frame, so an animated ancestor does not glide it — it forces
 * VS Code to relayout on every frame of the transition. The marker lets the
 * stylesheet collapse those shell transitions to a single frame instead.
 */
function reflectActive(): void {
  if (typeof document === "undefined") return
  // Valued with the owner id rather than empty: `[data-pro-ide-active]` still
  // matches for the CSS guards, and a reader that cares *which* surface holds
  // the pane (or a human reading the DOM) no longer has to guess.
  if (owner) document.documentElement.setAttribute(ACTIVE_ATTR, owner.id)
  else document.documentElement.removeAttribute(ACTIVE_ATTR)
}

/**
 * Is a live Pro IDE pane pinned somewhere inside `element`?
 *
 * The native webview floats above the DOM: it cannot be clipped, tweened, or
 * transformed by CSS, and its bounds are re-pushed over IPC once per frame. So
 * any ancestor about to run a layout animation must first ask this and skip the
 * animation when it answers true — otherwise the pane either smears across
 * whatever the animation reveals, or forces VS Code to relayout every frame.
 *
 * Deliberately containment-based rather than owner-id matching: the caller is a
 * layout container that has no business knowing how surfaces name themselves,
 * and containment is the property that actually matters.
 */
export function isProIdePanePinnedWithin(element: Element | null | undefined): boolean {
  if (!element || !owner) return false
  return element.querySelector(`[${PRO_IDE_REGION_ATTR}]`) !== null
}

/** Serialize a native round-trip behind every previously queued one. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Take ownership of the pane and point it at `url` at `rect`. Revokes the
 * previous owner first. Rejects when the native webview can't be created or
 * navigated, so the caller can surface a retryable error.
 */
export function claimCodeServerPane(claim: CodeServerPaneClaim): Promise<void> {
  const { ownerId, root, url, rect, onRevoked } = claim
  if (owner && owner.id !== ownerId) {
    const previous = owner
    owner = null
    previous.onRevoked()
  }
  owner = { id: ownerId, onRevoked }
  // Bound synchronously, before the native round-trip, and left bound even when
  // that round-trip fails: the embed is only the *view*. `ensure` already
  // succeeded for this root by the time a surface claims, so code-server is
  // serving it and the agent channel can drive it whether or not a webview ever
  // painted. Clearing it on embed failure would make headless callers report
  // "no IDE" for an IDE that is demonstrably running.
  boundRoot = root
  lastRect = rect
  visible = true
  reflectActive()
  if (!isTauri()) return Promise.resolve()

  return enqueue(async () => {
    // A release/claim may have landed while this task waited its turn.
    if (owner?.id !== ownerId) return
    const target = lastRect ?? rect
    if (!created) {
      await codeServerClient.embedCreate(url, target, backgroundHex ?? undefined)
      created = true
      mountedUrl = url
      return
    }
    if (mountedUrl !== url) {
      await codeServerClient.embedNavigate(url)
      mountedUrl = url
    }
    await codeServerClient.embedSetBounds(target)
  })
}

/** Push a new reserved-rect for the owning surface. Ignored for non-owners. */
export function updateCodeServerPaneRect(ownerId: string, rect: ElementRect): void {
  if (owner?.id !== ownerId) return
  lastRect = rect
  // Parked webviews sit off-screen; don't churn their bounds back on-screen.
  if (!isTauri() || !created || !visible) return
  void enqueue(() => codeServerClient.embedSetBounds(rect)).catch(() => undefined)
}

/**
 * Show the pane at its last rect, or park it off-screen. Used when the region
 * scrolls away, a modal covers it, or the window is backgrounded — the native
 * layer cannot be CSS-clipped, so parking is the only way to yield.
 */
export function setCodeServerPaneVisible(ownerId: string, next: boolean): void {
  if (owner?.id !== ownerId) return
  visible = next
  if (!isTauri() || !created) return
  const rect = next ? (lastRect ?? PARKED_RECT) : PARKED_RECT
  void enqueue(() => codeServerClient.embedSetVisible(next, rect)).catch(() => undefined)
}

/**
 * Drop ownership and park the webview. Deliberately does NOT destroy it: the
 * next claim re-shows the same live VS Code instead of reloading the workbench.
 */
export function releaseCodeServerPane(ownerId: string): void {
  if (owner?.id !== ownerId) return
  owner = null
  visible = false
  reflectActive()
  if (!isTauri() || !created) return
  void enqueue(() => codeServerClient.embedSetVisible(false, PARKED_RECT)).catch(() => undefined)
}

/**
 * Tear the native webview down for good — an explicit stop of the code-server
 * behind it (Managed Processes kill / restart, Settings → Pro IDE reclaim) or
 * app teardown.
 *
 * The current owner is told it lost the pane, exactly as if another surface had
 * claimed it. Without that, the host stays in Pro IDE mode believing its pane is
 * live and re-claims on its next rect update — which resurrects a webview
 * pointed at a port nothing is serving any more, i.e. the dead page this destroy
 * was supposed to remove. Losing the pane is what the host already knows how to
 * handle: it falls back to Monaco.
 */
export function destroyCodeServerPane(): Promise<void> {
  const previous = owner
  owner = null
  previous?.onRevoked()
  visible = false
  reflectActive()
  const wasCreated = created
  created = false
  mountedUrl = null
  lastRect = null
  // The one path that actually ends the instance, so the one path that unbinds.
  boundRoot = null
  if (!isTauri() || !wasCreated) return Promise.resolve()
  return enqueue(() => codeServerClient.embedDestroy()).catch(() => undefined)
}

/** The surface currently holding the pane, if any. */
export function getCodeServerPaneOwner(): string | null {
  return owner?.id ?? null
}

/**
 * Project root of the bound Pro IDE, or null when none has been claimed since
 * the last `destroy`.
 *
 * This is the fallback target for every caller that can drive the editor without
 * hosting it — workflow nodes, agent tools, plan steps, issue runs. It stays
 * non-null across `release` on purpose (see {@link boundRoot}), so navigating
 * away from the editor does not un-address it.
 *
 * Returns a root, never a guarantee: the instance can still have exited since.
 * Callers surface the backend's own error rather than pre-checking here — a
 * liveness probe would be stale by the time the caller acted on it.
 */
export function getActiveProIdeRoot(): string | null {
  return boundRoot
}

/**
 * Remember the app background the pane webview should paint, and push it to a
 * live webview.
 *
 * Idempotent per colour: a no-op when the value hasn't changed, because the
 * appearance sync fires on every palette input and most of those changes leave
 * the background alone.
 */
export function setCodeServerPaneBackground(hex: string): void {
  if (backgroundHex === hex) return
  backgroundHex = hex
  if (!isTauri() || !created) return
  void enqueue(() => codeServerClient.embedSetBackground(hex)).catch(() => undefined)
}

/** Test-only: drop all state without touching the (mocked) native layer. */
export function __resetCodeServerPaneManagerForTesting(): void {
  owner = null
  boundRoot = null
  reflectActive()
  created = false
  mountedUrl = null
  lastRect = null
  visible = true
  backgroundHex = null
  queue = Promise.resolve()
}
