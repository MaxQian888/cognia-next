"use client"

/**
 * Consume a `?session=…&message=…` deep link and land on that message.
 *
 * Three things have to happen in order, and only the first is synchronous:
 *
 *  1. focus the conversation (the store seeds a loading slice for one it has
 *     never opened),
 *  2. WAIT for its history to hydrate out of Dexie — the message list cannot
 *     scroll to a row that does not exist yet, and a jump fired too early is a
 *     silent no-op,
 *  3. jump, then strip the params.
 *
 * Step 3 matters as much as the others: leaving the query in place means every
 * later re-render (and every back/forward) re-fires the jump, so the user cannot
 * scroll away from the linked message. `replaceState` rather than a router
 * navigation, so a consumed link does not become a history entry the Back
 * button returns to.
 */

import { useCallback, useEffect, useRef } from "react"

import { parseMessagePermalink, type ReadableParams } from "@/lib/chat/message-permalink"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

/**
 * How long to keep waiting for the session's history before giving up.
 *
 * A ceiling is required: the id may be stale (the conversation was deleted, or
 * the link came from another device), and without one the hook would sit armed
 * for the rest of the session and eventually fire at whatever message happened
 * to appear.
 */
export const PERMALINK_HYDRATION_TIMEOUT_MS = 10_000

export interface UseMessagePermalinkOptions {
  /** Usually `useSearchParams()`. */
  params: ReadableParams | null
  /** Injected for tests; defaults to stripping the query via `replaceState`. */
  onConsumed?: () => void
  /**
   * Called when the target was reachable in the store but the list refused the
   * jump, or when the hydration ceiling expired without the row ever arriving.
   * The caller owns the message, since only it knows which surface is showing.
   */
  onUnresolved?: () => void
}

function stripPermalinkParams() {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  url.search = ""
  window.history.replaceState(window.history.state, "", url.toString())
}

export function useMessagePermalink({
  params,
  onConsumed,
  onUnresolved,
}: UseMessagePermalinkOptions): void {
  const parsed = parseMessagePermalink(params)
  // Primitives, so the effects below can depend on the target without a new
  // object identity re-arming the link on every render.
  const sessionId = parsed?.sessionId ?? null
  const messageId = parsed?.messageId ?? null

  const armedKeyRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Held in a ref, and refreshed in an effect rather than during render, so
  // `disarm` can stay identity-stable: it is what the giving-up timer closes
  // over, and a new identity per render would rearm that timer endlessly.
  const onConsumedRef = useRef(onConsumed)
  const onUnresolvedRef = useRef(onUnresolved)
  useEffect(() => {
    onConsumedRef.current = onConsumed
    onUnresolvedRef.current = onUnresolved
  }, [onConsumed, onUnresolved])

  const jumpToMessage = useChatViewportStore((s) => s.jumpToMessage)
  // Subscribed purely so the arrival of history re-runs the effect below; the
  // effect itself reads fresh values off the store.
  const messages = useChatStore((s) => s.messages)
  const messagesLoading = useChatStore((s) => s.messagesLoading)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const disarm = useCallback((consumed: boolean) => {
    armedKeyRef.current = null
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!consumed) return
    const done = onConsumedRef.current
    if (done) done()
    else stripPermalinkParams()
  }, [])

  // Arm: focus the conversation and start the giving-up clock. Keyed so the
  // same link is never armed twice, and a different link re-arms.
  useEffect(() => {
    if (!sessionId || !messageId) return
    const key = `${sessionId}::${messageId}`
    if (armedKeyRef.current === key) return
    armedKeyRef.current = key
    if (useChatStore.getState().activeSessionId !== sessionId) {
      useChatStore.getState().setActiveSession(sessionId)
    }
    if (timerRef.current != null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // The ceiling expiring means the row never arrived — a stale id, a
      // deleted conversation, a link from another device. Strip the params so
      // it cannot re-fire, but say why rather than just doing nothing.
      disarm(true)
      onUnresolvedRef.current?.()
    }, PERMALINK_HYDRATION_TIMEOUT_MS)
  }, [sessionId, messageId, disarm])

  // Fire as soon as the linked message is actually on screen.
  useEffect(() => {
    if (!sessionId || !messageId) return
    if (armedKeyRef.current !== `${sessionId}::${messageId}`) return
    // Read fresh: `activeSessionId` from the subscription above is a render
    // behind the `setActiveSession` the arm effect just performed, so trusting
    // it here would disarm the link on the very first pass.
    const state = useChatStore.getState()
    if (state.activeSessionId !== sessionId) {
      // The user navigated elsewhere in the meantime. Dragging them back would
      // be worse than dropping the link.
      disarm(false)
      return
    }
    if (state.messagesLoading || !jumpToMessage) return
    // Wait for the ROW, not merely for `messagesLoading` to clear: the list is
    // what owns the jump, and it can only reach a message it renders.
    if (!state.messages.some((message) => message.id === messageId)) return

    // Jump BEFORE disarming, so a refusal is still a refusal of a real attempt
    // (the row is in `messages` but the list would not take it).
    if (jumpToMessage(messageId, undefined, { align: "center" })) {
      disarm(true)
      return
    }
    // Consume on refusal too, exactly as the hydration ceiling does. Leaving
    // the query in place looks like it preserves a retry, but does the
    // opposite: re-pushing the identical URL is a router no-op, so nothing
    // re-renders and the arm effect's deps never change — the second
    // "Locate in conversation" for the same tab did nothing at all. Clearing it
    // makes the next push a genuine change the hook can observe.
    disarm(true)
    onUnresolvedRef.current?.()
  }, [sessionId, messageId, activeSessionId, messages, messagesLoading, jumpToMessage, disarm])

  useEffect(() => () => disarm(false), [disarm])
}
