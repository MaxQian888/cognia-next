/**
 * The VS Code extension webviews on screen: panels
 * (`window.createWebviewPanel`) and views (`registerWebviewViewProvider`),
 * each a tab in the extension rail (`components/extensions/`).
 *
 * This module is the state those tabs render from, and the delivery of
 * messages into their frames. `webview-handlers.ts` changes it as the
 * extension host asks; the rail components read it with
 * `useSyncExternalStore`.
 *
 * A message for a frame waits until the frame has run its scripts (VS Code
 * delivers nothing to a webview that is still loading). A webview with no
 * frame (an unselected tab without `retainContextWhenHidden`) gets nothing,
 * and `postMessage` reports that.
 */

export interface VscodeWebviewOptions {
  enableScripts: boolean
  enableForms: boolean
  /** `true` for every command, or the commands `command:` links may run. */
  enableCommandUris: boolean | string[]
  /** URI strings; absent means the extension's directory and the workspace folders. */
  localResourceRoots?: string[]
  /** Keep the frame alive while its tab is not shown. */
  retainContextWhenHidden: boolean
}

export interface VscodeWebviewRecord {
  handle: string
  pluginId: string
  kind: "panel" | "view"
  /** A panel's `viewType`, or a view's id. */
  viewType: string
  title: string
  description?: string
  badge?: { value: number; tooltip: string }
  html: string
  options: VscodeWebviewOptions
  /** Bumped whenever the document must be rebuilt (new html or options). */
  revision: number
  /** The last state the frame saved with `setState`. */
  state: unknown
  /** A view's provider token. */
  token?: string
  /** A view's provider has been asked to fill it. Panels always are. */
  resolved: boolean
}

export const DEFAULT_WEBVIEW_OPTIONS: VscodeWebviewOptions = {
  enableScripts: false,
  enableForms: false,
  enableCommandUris: false,
  retainContextWhenHidden: false,
}

type Poster = (message: unknown) => boolean

const webviews = new Map<string, VscodeWebviewRecord>()
let snapshot: readonly VscodeWebviewRecord[] = []
let selected: string | null = null
const listeners = new Set<() => void>()
const frames = new Map<string, Poster>()

function emit(): void {
  snapshot = [...webviews.values()]
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn("webview-bridge: listener threw:", error)
    }
  }
}

export function subscribeWebviews(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable until something changes, for `useSyncExternalStore`. */
export function listWebviews(): readonly VscodeWebviewRecord[] {
  return snapshot
}

export function getWebview(handle: string): VscodeWebviewRecord | undefined {
  return webviews.get(handle)
}

export function getSelectedWebview(): string | null {
  return selected
}

export function addWebview(
  record: Omit<VscodeWebviewRecord, "revision" | "state" | "resolved"> & { resolved?: boolean },
  options: { select: boolean }
): VscodeWebviewRecord {
  const added: VscodeWebviewRecord = {
    ...record,
    revision: 0,
    state: undefined,
    resolved: record.resolved ?? record.kind === "panel",
  }
  webviews.set(added.handle, added)
  if (options.select || selected === null) selected = added.handle
  emit()
  return added
}

export interface WebviewPatch {
  html?: string
  options?: VscodeWebviewOptions
  title?: string
  description?: string | null
  badge?: { value: number; tooltip: string } | null
  resolved?: boolean
}

export function updateWebview(handle: string, patch: WebviewPatch): boolean {
  const current = webviews.get(handle)
  if (!current) return false
  const next: VscodeWebviewRecord = { ...current }
  if (patch.html !== undefined) next.html = patch.html
  if (patch.options !== undefined) next.options = patch.options
  // Setting html, even to the same text, reloads the webview, as in VS Code.
  if (patch.html !== undefined || patch.options !== undefined) next.revision += 1
  if (patch.title !== undefined) next.title = patch.title
  if (patch.description !== undefined) next.description = patch.description ?? undefined
  if (patch.badge !== undefined) next.badge = patch.badge ?? undefined
  if (patch.resolved !== undefined) next.resolved = patch.resolved
  webviews.set(handle, next)
  emit()
  return true
}

export function removeWebview(handle: string): VscodeWebviewRecord | undefined {
  const removed = webviews.get(handle)
  if (!removed) return undefined
  const order = [...webviews.keys()]
  webviews.delete(handle)
  frames.delete(handle)
  if (selected === handle) {
    // The tab after it, else the one before, as a tab strip does.
    const index = order.indexOf(handle)
    selected = order[index + 1] ?? order[index - 1] ?? null
  }
  emit()
  return removed
}

export function selectWebview(handle: string): boolean {
  if (!webviews.has(handle)) return false
  if (selected !== handle) {
    selected = handle
    emit()
  }
  return true
}

/** The frame's `setState`, kept for its next load. */
export function setWebviewState(handle: string, state: unknown): void {
  const current = webviews.get(handle)
  if (current) webviews.set(handle, { ...current, state })
}

/** A frame is ready for messages; returns its detach. */
export function attachWebviewFrame(handle: string, poster: Poster): () => void {
  frames.set(handle, poster)
  return () => {
    if (frames.get(handle) === poster) frames.delete(handle)
  }
}

/** Deliver an extension's message to its frame; false when none is live. */
export function postToWebview(handle: string, message: unknown): boolean {
  const poster = frames.get(handle)
  if (!poster) return false
  try {
    return poster(message)
  } catch (error) {
    console.warn(`webview-bridge: delivery to ${handle} threw:`, error)
    return false
  }
}

export function __resetWebviewBridgeForTesting(): void {
  webviews.clear()
  snapshot = []
  selected = null
  listeners.clear()
  frames.clear()
}
