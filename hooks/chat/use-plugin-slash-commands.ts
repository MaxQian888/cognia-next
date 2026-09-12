"use client"

/**
 * Reactive source of plugin-contributed slash commands for the chat composer's
 * `/` picker. The unified registry (`lib/slash-commands/registry.ts`) holds
 * every plugin command, but the composer historically only read
 * `BUILTIN_SLASH_COMMANDS` + custom `.md` — so plugin commands were registered
 * yet never surfaced in chat. This hook bridges that gap.
 *
 * The registry is a bare Map, so we subscribe via `useSyncExternalStore` to its
 * version counter and re-derive the projected `SlashCommand[]` only when the
 * registry actually changes (a plugin enabling/disabling adds/removes commands).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import type { SlashCommand, SlashContext } from "@/lib/slash-commands/builtin"
import { getPluginSlashCommands } from "@/lib/slash-commands/plugin-commands"
import { getSlashCommandsVersion, subscribeSlashCommands } from "@/lib/slash-commands/registry"

export function usePluginSlashCommands(): SlashCommand[] {
  const version = useSyncExternalStore(
    subscribeSlashCommands,
    getSlashCommandsVersion,
    // Server snapshot: the registry is empty during SSR/static export.
    getSlashCommandsVersion
  )
  // `version` is the change signal: it isn't read inside, but re-deriving the
  // projection when the registry mutates is the whole point.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getPluginSlashCommands(), [version])
}

/** One command run owned by this composer and its session. */
export function usePluginSlashCommandExecution(sessionId: string | null) {
  const current = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<{
    sessionId: string | null
    command: string
    value?: number
    message?: string
  } | null>(null)

  const cancel = useCallback(() => {
    const controller = current.current
    current.current = null
    controller?.abort()
    setProgress(null)
  }, [])

  useEffect(() => {
    return () => {
      const controller = current.current
      current.current = null
      controller?.abort()
      setProgress(null)
    }
  }, [sessionId])

  const run = useCallback(
    async (command: SlashCommand, context: SlashContext) => {
      if (current.current || !command.handler) return false
      const controller = new AbortController()
      current.current = controller
      const isCurrent = () => current.current === controller && !controller.signal.aborted
      setProgress({ sessionId, command: command.name })
      let onAbort: () => void
      const cancelled = new Promise<false>((resolve) => {
        onAbort = () => resolve(false)
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        const execution = Promise.resolve().then(async () => {
          if (!isCurrent()) return false
          await command.handler!({
            ...context,
            signal: controller.signal,
            reportProgress: (value, message) => {
              if (!isCurrent() || !Number.isFinite(value)) return
              setProgress({
                sessionId,
                command: command.name,
                value: Math.min(1, Math.max(0, value)),
                message,
              })
            },
            pushSystemMessage: (message) => {
              if (isCurrent()) context.pushSystemMessage(message)
            },
          })
          return isCurrent()
        })
        // Release the input even if a third-party handler ignores cancellation.
        // Promise.race still observes any eventual rejection from that handler.
        return await Promise.race([execution, cancelled])
      } finally {
        controller.signal.removeEventListener("abort", onAbort!)
        if (current.current === controller) {
          current.current = null
          setProgress(null)
        }
      }
    },
    [sessionId]
  )

  return {
    progress: progress?.sessionId === sessionId ? progress : null,
    run,
    cancel,
  }
}
