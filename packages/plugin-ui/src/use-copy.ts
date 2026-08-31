"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export interface UseCopyOptions {
  resetMs?: number
  logger?: { warn: (message: string, data?: Record<string, unknown>) => void }
  scope?: string
}

export interface UseCopyResult {
  copied: boolean
  isCopying: boolean
  copy: (value: string) => Promise<boolean>
}

/** Clipboard helper with a DOM fallback suitable for every plugin surface. */
export function useCopy(options: UseCopyOptions | number = {}): UseCopyResult {
  const opts = typeof options === "number" ? { resetMs: options } : options
  const resetMs = opts.resetMs ?? 1500
  const [copied, setCopied] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(
    async (value: string) => {
      setIsCopying(true)
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value)
        } else if (typeof document !== "undefined") {
          const textarea = document.createElement("textarea")
          textarea.value = value
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          document.body.appendChild(textarea)
          try {
            textarea.select()
            if (!document.execCommand("copy")) return false
          } finally {
            textarea.remove()
          }
        } else {
          return false
        }
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetMs)
        return true
      } catch (error) {
        opts.logger?.warn(`${opts.scope ?? "plugin"} clipboard write failed`, {
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        setIsCopying(false)
      }
    },
    [opts.logger, opts.scope, resetMs]
  )

  return { copied, isCopying, copy }
}
