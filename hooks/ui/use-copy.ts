"use client"

import { useCallback, useRef, useState } from "react"

import { loggers } from "@/lib/logging"
import { writeText as capWriteText } from "@/lib/capacitor/clipboard"

export interface UseCopyOptions {
  /** Milliseconds to keep `copied` true after a successful write. Defaults to 1500. */
  resetMs?: number
  /**
   * Logger scope for write failures. Defaults to `loggers.ui`.
   * Pass e.g. `loggers.chat` from chat-side callers so failures land in the chat audit trail.
   */
  logger?: { warn: (message: string, data?: Record<string, unknown>) => void }
  /** Override label appended to the warn message ({scope} clipboard write failed). Defaults to "ui". */
  scope?: string
}

export interface UseCopyResult {
  copied: boolean
  /** Cognia compatibility alias — true while the clipboard write is in flight. */
  isCopying: boolean
  copy: (value: string) => Promise<boolean>
}

/**
 * Tiny clipboard helper. Returns a `copied` flag that auto-resets after `resetMs`.
 * Failures are logged through the supplied logger (defaults to the `ui` module).
 */
export function useCopy(options: UseCopyOptions | number = {}): UseCopyResult {
  const opts = typeof options === "number" ? { resetMs: options } : options
  const resetMs = opts.resetMs ?? 1500
  const logger = opts.logger ?? loggers.ui
  const scope = opts.scope ?? "ui"

  const [copied, setCopied] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback(
    async (value: string) => {
      setIsCopying(true)
      try {
        // Native mobile clipboard first — Capacitor's WebView frequently blocks
        // `navigator.clipboard`. The wrapper self-gates to mobile, so this is a
        // fast no-op (`unsupported`) on web / Tauri and the web paths below run.
        const cap = await capWriteText(value)
        if (cap.kind === "ok") {
          // fall through to the shared success bookkeeping below.
        } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value)
        } else if (typeof document !== "undefined") {
          const ta = document.createElement("textarea")
          ta.value = value
          ta.style.position = "fixed"
          ta.style.opacity = "0"
          document.body.appendChild(ta)
          ta.select()
          document.execCommand("copy")
          ta.remove()
        } else {
          return false
        }
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetMs)
        return true
      } catch (err) {
        logger.warn(`${scope} clipboard write failed`, {
          err: err instanceof Error ? err.message : String(err),
        })
        return false
      } finally {
        setIsCopying(false)
      }
    },
    [resetMs, logger, scope]
  )

  return { copied, isCopying, copy }
}
