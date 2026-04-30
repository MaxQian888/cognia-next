"use client"

import { useEffect, useRef } from "react"
import { useChatStore, type ChatStatus } from "@/stores/chat"
import { isTauri } from "@/lib/tauri"
import { notify } from "@/lib/tauri/notification"

/**
 * Fire a native notification when a Claude session stops streaming, but
 * only while the window is unfocused — there's no point pinging a user
 * who's already watching the output stream.
 *
 * Mounted once near the root via `tauri-provider.tsx`.
 */
export function useSessionNotifications(): void {
  const prevStatus = useRef<ChatStatus>("idle")

  useEffect(() => {
    if (!isTauri()) return
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
        title: errored ? "Cognia · session error" : "Cognia · response ready",
        body: errored
          ? state.errorMessage || "The session ended with an error."
          : "Claude finished generating.",
      })
    })
    return () => {
      unsub()
    }
  }, [])
}
