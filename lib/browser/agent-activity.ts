/**
 * Tiny window-event bus so the `/browser` pane can show when the AGENT (not the
 * human) is driving the embedded preview. The browser-tools engine runs in the
 * renderer (resolved by `plugin-tool-ipc`), so a same-window CustomEvent reaches
 * the React UI without any IPC. No-op outside the browser (SSR / sidecar).
 */
export const BROWSER_AGENT_ACTIVITY_EVENT = "cognia:browser-agent-activity"

export interface BrowserAgentActivity {
  /** Short human-readable description of what the agent just did. */
  action: string
}

/** Announce an agent browser action (navigate / click / type / …). */
export function emitAgentActivity(action: string): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return
  window.dispatchEvent(
    new CustomEvent<BrowserAgentActivity>(BROWSER_AGENT_ACTIVITY_EVENT, { detail: { action } })
  )
}

/** Subscribe to agent browser activity. Returns an unsubscribe function. */
export function onAgentActivity(cb: (activity: BrowserAgentActivity) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {}
  }
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<BrowserAgentActivity>).detail
    if (detail) cb(detail)
  }
  window.addEventListener(BROWSER_AGENT_ACTIVITY_EVENT, handler)
  return () => window.removeEventListener(BROWSER_AGENT_ACTIVITY_EVENT, handler)
}
