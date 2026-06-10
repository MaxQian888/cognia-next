"use client"

import { useEffect } from "react"

import { useSettingsStore } from "@/stores/settings"
import { setChatMiddlewareExecutionEnabled } from "@/lib/claude/chat-middleware/feature-flag"

/**
 * Boot-time initializer that rehydrates the chat-middleware execution flag
 * (`lib/claude/chat-middleware/feature-flag.ts`) from persisted settings.
 *
 * The flag is a module-level boolean consulted on the send hot path; it must be
 * seeded from `AppSettings.developer.chatMiddlewareExecution` at startup and
 * kept in sync on every settings change. The settings store hydrates
 * asynchronously, so this applies the current snapshot then subscribes — the
 * setter is idempotent, so re-applying the same value is cheap. Mirrors the
 * `PetWindowInitializer` shape so the `app/layout.tsx` initializer block stays
 * homogeneous.
 */
export function ChatMiddlewareFlagInitializer() {
  useEffect(() => {
    const apply = (settings: ReturnType<typeof useSettingsStore.getState>["settings"]) => {
      setChatMiddlewareExecutionEnabled(Boolean(settings?.developer?.chatMiddlewareExecution))
    }

    apply(useSettingsStore.getState().settings)
    const unsubscribe = useSettingsStore.subscribe((state) => apply(state.settings))
    return () => {
      unsubscribe()
    }
  }, [])

  return null
}

export default ChatMiddlewareFlagInitializer
