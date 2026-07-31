"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Build the OS/document window title: `"<conversation> · <appName>"`, or just
 * the app name when no conversation label is available. Doc-first to match the
 * existing share-view convention (`app/share/view/page.tsx`).
 */
export function computeWindowTitle(doc: string | null | undefined, appName: string): string {
  const trimmed = doc?.trim()
  return trimmed ? `${trimmed} · ${appName}` : appName
}

/**
 * Sync the OS window title (taskbar / app switcher / Alt-Tab) and the browser
 * `document.title` to the active conversation. Derived from the **persisted**
 * session title via {@link useActiveSessionLabel} — never from streaming
 * status — so it does not flicker per token, and it only writes when the
 * computed string actually changes. In Tauri it also calls
 * `getCurrentWindow().setTitle`; in the browser / Capacitor shells the
 * `document.title` write is the meaningful one.
 */
export function useWindowTitle(): void {
  const t = useTranslations("desktop.titleBar")
  const appName = t("appName")
  const { label } = useActiveSessionLabel()
  const title = computeWindowTitle(label, appName)
  const lastRef = useRef<string | null>(null)

  useEffect(() => {
    // Effects run client-side only, so `document` is always present here.
    if (lastRef.current === title) return
    lastRef.current = title
    document.title = title

    // Only the main window owns the OS title bar. Least-privilege pet windows
    // aren't granted `core:window:allow-set-title` (see
    // `src-tauri/capabilities/pet.json`), so the native write only warns there;
    // the `document.title` write above is harmless and stays.
    if (!isTauri() || !isMainAppWindow()) return
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        await getCurrentWindow().setTitle(title)
      } catch (err) {
        log.warn("window-title set failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }, [title])
}
