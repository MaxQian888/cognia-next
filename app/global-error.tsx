"use client"

/**
 * Root layout error boundary. Fires when the root `app/layout.tsx` itself
 * crashes — at that point the next-intl provider, theme provider, app shell,
 * and TitleBar have all unmounted, so this file must:
 *   1. Render its own `<html><body>` (Next.js convention)
 *   2. Provide a minimal rescue chrome so users can still close the Tauri
 *      window — otherwise the user is trapped in a broken WebView with no
 *      titlebar close button.
 *   3. Use static English copy (`staticLocale="en"` on the ErrorPage) since
 *      the i18n provider isn't available here.
 *
 * Imports `./globals.css` so Tailwind utility classes resolve.
 */

import { useEffect, useState } from "react"
import { XIcon } from "lucide-react"

import { ErrorPage } from "@/components/error/error-page"
import { isTauri } from "@/lib/tauri"
import "./globals.css"

interface WindowApi {
  close: () => Promise<void>
}

async function getWin(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow() as unknown as WindowApi
}

function RescueChrome() {
  const [mounted, setMounted] = useState(false)
  const [tauri, setTauri] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    setTauri(isTauri())
  }, [])

  const handleClose = async () => {
    try {
      const win = await getWin()
      await win.close()
    } catch {
      /* not in Tauri or window API unavailable — fall through */
    }
  }

  if (!mounted || !tauri) {
    // Browser preview: no native window to close; render an empty drag region
    // so the rescue layout is identical regardless of host.
    return <div className="h-8 shrink-0 border-b bg-muted/40" />
  }

  return (
    <header
      data-tauri-drag-region
      data-testid="global-error-rescue-chrome"
      className="relative flex h-8 shrink-0 items-center justify-end border-b bg-muted/40 text-xs select-none"
    >
      <button
        type="button"
        onClick={handleClose}
        aria-label="Close window"
        data-testid="global-error-close-window"
        className="flex h-8 w-10 items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </header>
  )
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <div className="flex h-screen w-full flex-col">
          <RescueChrome />
          <div className="flex flex-1 items-center justify-center overflow-auto">
            <ErrorPage variant="global-error" error={error} reset={reset} staticLocale="en" />
          </div>
        </div>
      </body>
    </html>
  )
}
