"use client"

import { makeDefaultLoader, withPlugin } from "./_shared"

/**
 * `@capacitor/share` wrapper. Surfaces the system share sheet for the chat
 * forward menu (Wave 2) and per-message export. Falls back to navigator.share
 * on web when available.
 */

interface ShareShape {
  share(opts: {
    title?: string
    text?: string
    url?: string
    files?: string[]
    dialogTitle?: string
  }): Promise<{ activityType?: string }>
  canShare(): Promise<{ value: boolean }>
}

export type ShareLoader = () => Promise<ShareShape>

const defaultLoader: ShareLoader = makeDefaultLoader<ShareShape>("@capacitor/share", "Share")

export interface ShareOptions {
  title?: string
  text?: string
  url?: string
  files?: string[]
  dialogTitle?: string
  loader?: ShareLoader
}

export type ShareOutcome =
  | { kind: "shared"; activityType?: string }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function share(opts: ShareOptions): Promise<ShareOutcome> {
  const { title, text, url, files, dialogTitle, loader = defaultLoader } = opts

  // Try native plugin first.
  try {
    const plugin = await loader()
    try {
      const can = await plugin.canShare()
      if (!can.value) {
        return webShareFallback({ title, text, url })
      }
      const result = await plugin.share({ title, text, url, files, dialogTitle })
      return { kind: "shared", activityType: result.activityType }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(msg)) return { kind: "cancelled" }
      return { kind: "error", message: msg }
    }
  } catch {
    return webShareFallback({ title, text, url })
  }
}

async function webShareFallback(opts: {
  title?: string
  text?: string
  url?: string
}): Promise<ShareOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share(opts)
      return { kind: "shared" }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort|cancel/i.test(msg)) return { kind: "cancelled" }
      return { kind: "error", message: msg }
    }
  }
  return { kind: "unsupported" }
}
