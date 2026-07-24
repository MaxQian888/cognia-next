/**
 * Webview registry (B3) — holds resolved plugin webviews keyed by
 * `<pluginId>:<viewId>`, plus the message plumbing between the host iframe and
 * the plugin: an inbound listener set (iframe → plugin) and an attached
 * "poster" the host installs so the plugin can push messages into the iframe
 * (plugin → iframe).
 *
 * The plugin-webview-bridge registers resolved webviews on enable; the manager
 * module-bridge unregister drops them on disable. The B1 container panel reads
 * `listWebviewsForContainer` and renders each via PluginWebviewHost.
 */

import type { ResolvedPluginWebview, PluginWebviewMessage } from "@/types/plugin/plugin-webview"
import { loggers } from "@cognia/logging"

const webviews = new Map<string, ResolvedPluginWebview>()
/**
 * Host-installed posters: push a message into a webview's iframe. A Set per id
 * because the same webview can have two live iframes at once — the mobile
 * sheet `forceMount`s a hidden workbench next to the desktop dock — and a
 * single slot let the last-mounted frame silently starve the other.
 */
const posters = new Map<string, Set<(data: unknown) => boolean>>()
/** Inbound (iframe → plugin) listeners per webview. */
const inboundListeners = new Map<string, Set<(m: PluginWebviewMessage) => void>>()
/**
 * Last `setState` payload per webview. The iframe is destroyed whenever its
 * panel unmounts (workbench collapse, resource switch, container close), so
 * in-frame state must live OUT here to survive to the next mount — the host
 * replays it into the fresh frame on load. Runtime-only: cleared with the
 * webview on plugin disable, never written to disk.
 */
const webviewStates = new Map<string, unknown>()

type Listener = () => void
const listeners = new Set<Listener>()
let snapshot: readonly ResolvedPluginWebview[] | null = null

function emit(): void {
  snapshot = null
  if (listeners.size === 0) return
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        loggers.plugin.warn("webview registry listener threw", { error: String(err) })
      }
    }
  })
}

function keyOf(w: ResolvedPluginWebview): string {
  return `${w.pluginId}:${w.viewId}`
}

export function registerWebview(webview: ResolvedPluginWebview): () => void {
  const key = keyOf(webview)
  webviews.set(key, webview)
  emit()
  return () => {
    if (webviews.delete(key)) {
      posters.delete(key)
      inboundListeners.delete(key)
      webviewStates.delete(key)
      emit()
    }
  }
}

export function unregisterWebviewsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [key, w] of webviews) {
    if (w.pluginId === pluginId) {
      webviews.delete(key)
      posters.delete(key)
      inboundListeners.delete(key)
      webviewStates.delete(key)
      removed++
    }
  }
  if (removed > 0) emit()
  return removed
}

/** Store the frame's `setState` payload so a future mount can be seeded with it. */
export function setWebviewState(fullId: string, state: unknown): void {
  webviewStates.set(fullId, state)
}

export function getWebviewState(fullId: string): unknown {
  return webviewStates.get(fullId)
}

export function getWebview(fullId: string): ResolvedPluginWebview | undefined {
  return webviews.get(fullId)
}

export function getWebviewSnapshot(): readonly ResolvedPluginWebview[] {
  if (!snapshot) snapshot = [...webviews.values()]
  return snapshot
}

export function listWebviewsForContainer(containerId: string): ResolvedPluginWebview[] {
  return getWebviewSnapshot().filter((w) => w.containerId === containerId)
}

export function subscribeWebviews(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// ── Message plumbing ──────────────────────────────────────────────────────

/** The host (PluginWebviewHost) installs a poster when its iframe mounts. */
export function attachWebviewPoster(
  fullId: string,
  poster: (data: unknown) => boolean
): () => void {
  let set = posters.get(fullId)
  if (!set) {
    set = new Set()
    posters.set(fullId, set)
  }
  set.add(poster)
  return () => {
    const current = posters.get(fullId)
    if (!current) return
    current.delete(poster)
    if (current.size === 0) posters.delete(fullId)
  }
}

/** Push a message into every live iframe of a webview (plugin → iframe). */
export function postMessageToWebview(fullId: string, data: unknown): boolean {
  const set = posters.get(fullId)
  if (!set || set.size === 0) return false
  let delivered = false
  for (const poster of set) {
    try {
      delivered = poster(data) || delivered
    } catch (err) {
      loggers.plugin.warn("webview poster threw", { fullId, error: String(err) })
    }
  }
  return delivered
}

/** Dispatch an inbound message (iframe → plugin) to listeners. */
export function dispatchWebviewMessage(fullId: string, message: PluginWebviewMessage): void {
  const set = inboundListeners.get(fullId)
  if (!set) return
  for (const fn of set) {
    try {
      fn(message)
    } catch (err) {
      loggers.plugin.warn("webview inbound listener threw", { fullId, error: String(err) })
    }
  }
}

/** Subscribe to inbound messages from a webview's iframe. */
export function onWebviewMessage(
  fullId: string,
  listener: (m: PluginWebviewMessage) => void
): () => void {
  let set = inboundListeners.get(fullId)
  if (!set) {
    set = new Set()
    inboundListeners.set(fullId, set)
  }
  set.add(listener)
  return () => set!.delete(listener)
}

export function __resetWebviewsForTesting(): void {
  webviews.clear()
  posters.clear()
  inboundListeners.clear()
  webviewStates.clear()
  listeners.clear()
  snapshot = null
}
