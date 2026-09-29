"use client"

// Notify when a conversation the user is not watching needs them: it finished,
// it failed, or it is waiting for an approval. Every live session counts — the
// open panes and the ones held in the background with no pane (project threads
// and their coordinator, ADR-0204) — except the one on screen while the window
// has focus. Routes through the Unified Notification Center (ADR-0042); the
// session's workspace is resolved from `sourceRef`, so per-workspace rules
// apply. Mounted once near the root via `tauri-provider.tsx`.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useChatStore, type ChatStatus } from "@/stores/chat"
import type { SessionChatSlice } from "@/stores/chat/chat-store"
import { notify } from "@/lib/notifications/runtime"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { getSession } from "@/lib/db/sessions"

export type SessionNotificationKind = "finished" | "error" | "approval"

export interface SessionNotificationEvent {
  sessionId: string
  kind: SessionNotificationKind
  errorMessage?: string | null
}

type Slices = Record<string, Pick<SessionChatSlice, "status" | "errorMessage">>

/**
 * The transitions worth telling the user about, between two store snapshots.
 * Pure. `focusedSessionId` is the session on screen in a focused window —
 * the user is already watching it.
 */
export function sessionNotificationEvents(
  prev: Slices | undefined,
  next: Slices,
  focusedSessionId: string | null
): SessionNotificationEvent[] {
  const events: SessionNotificationEvent[] = []
  for (const [sessionId, slice] of Object.entries(next)) {
    if (sessionId === focusedSessionId) continue
    const before: ChatStatus = prev?.[sessionId]?.status ?? "idle"
    const after = slice.status
    if (before === after) continue
    if (after === "awaiting_approval") {
      events.push({ sessionId, kind: "approval" })
    } else if (before === "streaming" && after === "error") {
      events.push({ sessionId, kind: "error", errorMessage: slice.errorMessage })
    } else if (before === "streaming" && after === "idle") {
      events.push({ sessionId, kind: "finished" })
    }
  }
  return events
}

function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus()
}

export function useSessionNotifications(): void {
  const t = useTranslations("notificationCenter.session")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    const unsub = useChatStore.subscribe((state, prev) => {
      if (state.sessions === prev?.sessions) return
      const focused = windowFocused()
      const events = sessionNotificationEvents(
        prev?.sessions,
        state.sessions,
        focused ? state.activeSessionId : null
      )
      for (const event of events) void deliver(event, focused, tRef.current)
    })
    return () => {
      unsub()
    }
  }, [])
}

async function deliver(
  event: SessionNotificationEvent,
  focused: boolean,
  t: ReturnType<typeof useTranslations>
): Promise<void> {
  const title = (await getSession(event.sessionId).catch(() => undefined))?.title?.trim()
  const named = (key: string, fallback: string) => (title ? t(key, { title }) : t(fallback))
  // In a focused window a toast is enough; an OS banner is for when the user
  // is elsewhere. Routing still applies mute, level gates and quiet hours.
  const channels: Array<"center" | "toast" | "os"> = focused
    ? ["center", "toast"]
    : ["center", "os"]
  const common = {
    source: "session" as const,
    channels,
    groupKey: "session",
    href: buildSessionHref(event.sessionId),
    sourceRef: { kind: "session", id: event.sessionId },
  }
  if (event.kind === "approval") {
    await notify({
      ...common,
      level: "warning",
      title: t("approvalTitle"),
      body: named("approvalBody", "approvalBodyUnnamed"),
      // Work is blocked on a person, which is what the numeric badge counts.
      directed: true,
      dedupeKey: `session-approval:${event.sessionId}`,
    })
    return
  }
  const errored = event.kind === "error"
  await notify({
    ...common,
    level: errored ? "error" : "success",
    title: errored ? t("errorTitle") : t("readyTitle"),
    body: errored
      ? event.errorMessage || named("errorBodyNamed", "errorBody")
      : named("readyBodyNamed", "readyBody"),
  })
}
