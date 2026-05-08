"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/toast` wrapper. On mobile this surfaces a system-level toast;
 * on desktop and web the call is a no-op (callers should fall back to
 * `sonner` for those targets, e.g. in `feedback.ts`).
 */

export type ToastDuration = "short" | "long"
export type ToastPosition = "top" | "center" | "bottom"

interface ToastShape {
  show(opts: { text: string; duration?: ToastDuration; position?: ToastPosition }): Promise<void>
}

export type ToastLoader = () => Promise<ToastShape>

const defaultLoader: ToastLoader = makeDefaultLoader<ToastShape>("@capacitor/toast", "Toast")

export interface ShowToastOptions {
  text: string
  duration?: ToastDuration
  position?: ToastPosition
  loader?: ToastLoader
}

export async function showToast(opts: ShowToastOptions): Promise<SimpleOutcome> {
  const { text, duration = "short", position = "bottom", loader = defaultLoader } = opts
  return withPlugin(loader, async (toast) => {
    await toast.show({ text, duration, position })
    return { kind: "ok" as const }
  })
}
