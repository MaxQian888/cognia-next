"use client"

// Fire a notification when a Claude session stops streaming while the window is
// unfocused — no point pinging a user already watching the stream. Routes
// through the Unified Notification Center (ADR-0042): a durable center record
// plus an OS notification (the core gates OS by permission / DND). Mounted once
// near the root via `tauri-provider.tsx`.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useChatStore, type ChatStatus } from "@/stores/chat"
import { notify } from "@/lib/notifications/runtime"

export function useSessionNotifications(): void {
  const t = useTranslations("notificationCenter.session")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const prevStatus = useRef<ChatStatus>("idle")

  useEffect(() => {
    const unsub = useChatStore.subscribe((state, prev) => {
      const next = state.status
      const before = prev?.status ?? prevStatus.current
      prevStatus.current = next

      // Only react to streaming → terminal transitions.
      const ending = before === "streaming" && (next === "idle" || next === "error")
      if (!ending) return

      // Skip if the user is already looking at the window.
      if (typeof document !== "undefined" && document.hasFocus()) return

      const errored = next === "error"
      void notify({
        source: "session",
        level: errored ? "error" : "success",
        title: errored ? tRef.current("errorTitle") : tRef.current("readyTitle"),
        body: errored ? state.errorMessage || tRef.current("errorBody") : tRef.current("readyBody"),
        channels: ["center", "os"],
        groupKey: "session",
      })
    })
    return () => {
      unsub()
    }
  }, [])
}
