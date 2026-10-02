"use client"

/**
 * A link that leaves the status page.
 *
 * On the hosted primary page and the mirror it is an ordinary anchor. Inside
 * Cognia (`app` runtime) a `target="_blank"` anchor is unreliable — Tauri
 * ignores it and Android WebViews block new windows — so the click goes
 * through the shared cross-platform opener instead.
 */

import type { ReactNode } from "react"

import { openExternal } from "@/lib/tauri/opener"
import type { StatusRuntimeMode } from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

export function StatusExternalLink({
  href,
  mode,
  children,
  className,
}: {
  href: string
  mode: StatusRuntimeMode
  children: ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      onClick={
        mode === "app"
          ? (event) => {
              event.preventDefault()
              void openExternal(href)
            }
          : undefined
      }
    >
      {children}
    </a>
  )
}
