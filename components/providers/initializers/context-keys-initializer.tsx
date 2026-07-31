"use client"

// Feeds the plugin context-key store (`lib/plugin/context-keys`) from the live
// app stores so `when`-clause evaluation (UI slots, commands, view containers)
// reflects real state. Mirrors VS Code's context-key model: this is the single
// writer that projects chat / project / ui / plugin-runtime state + platform +
// route into flat boolean keys. Plugins may add their own keys on top via
// `ctx`/`setContextKey`; this component never deletes those.

import { useEffect } from "react"
import { usePathname } from "next/navigation"

import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import { useProjectStore } from "@/stores/project/project-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { isTauri } from "@/lib/tauri"
import { setContextKey, setContextKeys } from "@/lib/plugin/context-keys/context-key-store"
import { deriveContextKeys, detectOs } from "@/lib/plugin/context-keys/derive-context-keys"

export function ContextKeysInitializer() {
  const status = useChatStore((s) => s.status)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messageCount = useChatStore((s) => s.messages.length)
  const guildKind = useUIStore((s) => s.selectedGuild.kind)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const plugins = usePluginStore((s) => s.plugins)
  const pathname = usePathname()

  // Project the enumerated / boolean dimensions on any relevant change.
  useEffect(() => {
    const allPluginIds = Object.keys(plugins)
    const enabledPluginIds = allPluginIds.filter((id) => plugins[id]?.status === "enabled")
    setContextKeys(
      deriveContextKeys({
        isTauri: isTauri(),
        os: detectOs(),
        chatActive: !!activeSessionId,
        chatStreaming: status === "streaming",
        chatHasMessages: messageCount > 0,
        projectActive: !!activeProjectId,
        guildKind,
        allPluginIds,
        enabledPluginIds,
      })
    )
  }, [status, activeSessionId, messageCount, guildKind, activeProjectId, plugins])

  // Route keys are open-ended, so manage `route.<seg>` imperatively: set the
  // current route true and clear it on change (the cleanup runs before the
  // next effect, flipping the previous route false).
  useEffect(() => {
    const seg = (pathname ?? "/").split("/").filter(Boolean)[0] ?? "home"
    const key = `route.${seg}`
    setContextKey(key, true)
    return () => setContextKey(key, false)
  }, [pathname])

  return null
}

export default ContextKeysInitializer
