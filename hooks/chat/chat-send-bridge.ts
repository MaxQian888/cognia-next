"use client"

/**
 * Minimal bridge from non-hook UI (message parts, inline cards) back into the
 * chat hook's `send`. Mirrors `registerBackgroundReplaySend` in
 * `background-result-runtime.ts`: the controller registers its send once, and
 * any rendered surface can then inject an ordinary user message into a session
 * without threading a callback through the whole transcript tree.
 *
 * Delivery inherits `send`'s own routing — a running turn turns the message
 * into a live steer or a queued replay, an idle one starts a fresh turn. That
 * is exactly what answering a non-blocking agent question wants (Codex's
 * async-question model: the answer is an ordinary message, never a waiter
 * resolution).
 */

export type ChatSendBridge = (text: string, sessionId: string) => void

let bridge: ChatSendBridge | undefined

/** Register the chat hook's send (returns an unregister for unmount). */
export function registerChatSendBridge(send: ChatSendBridge): () => void {
  bridge = send
  return () => {
    if (bridge === send) bridge = undefined
  }
}

/**
 * Send `text` into `sessionId` as an ordinary user message. Returns false when
 * no chat runtime is registered (hook not mounted) or the input is unusable —
 * callers can keep their affordance interactive rather than pretending an
 * answer was delivered.
 */
export function sendChatMessage(sessionId: string, text: string): boolean {
  if (!bridge || !sessionId || !text.trim()) return false
  bridge(text, sessionId)
  return true
}

/**
 * Re-run a session's last turn — the Retry on a transcript row whose turn never
 * ran (`components/chat/message-parts/turn-admission-badge.tsx`). A separate
 * registration because a retry is a regenerate, not a new message: the user's
 * message is already in the transcript and must not be appended again.
 */
export type ChatRetryBridge = (sessionId: string) => void

let retryBridge: ChatRetryBridge | undefined

export function registerChatRetryBridge(retry: ChatRetryBridge): () => void {
  retryBridge = retry
  return () => {
    if (retryBridge === retry) retryBridge = undefined
  }
}

/** Returns false when no chat runtime is mounted to run the retry. */
export function retryChatTurn(sessionId: string): boolean {
  if (!retryBridge || !sessionId) return false
  retryBridge(sessionId)
  return true
}

export function __resetChatSendBridgeForTesting(): void {
  bridge = undefined
  retryBridge = undefined
}
