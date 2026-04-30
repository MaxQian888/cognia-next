"use client"

import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logger"
import { cn } from "@/lib/utils"
import { MaximizeIcon, MinimizeIcon, MinusIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"

const log = loggers.ui

/**
 * Custom title bar shown when `decorations: false` in tauri.conf.json.
 *
 * On macOS we leave 80px on the left clear for the traffic lights (the
 * "Overlay" titleBarStyle in tauri.conf positions them inside our window).
 * Linux/Windows render their own min/max/close buttons here.
 */
export function TitleBar() {
  const t = useTranslations("desktop.titleBar")
  const [mounted, setMounted] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [platform, setPlatform] = useState<string>("")

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const win = getCurrentWindow()
        setMaximized(await win.isMaximized())
        // navigator.platform is deprecated but still populated by Webview2 /
        // WebKit and is good enough for titlebar-button decisions.
        if (typeof navigator !== "undefined") {
          setPlatform(navigator.platform.toLowerCase())
        }
        unlisten = await win.onResized(async () => {
          setMaximized(await win.isMaximized())
        })
      } catch (err) {
        log.warn("title-bar window setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      unlisten?.()
    }
  }, [])

  if (!mounted || !isTauri()) return null

  const isMac = platform.includes("mac")

  const handleMin = async () => {
    log.info("title-bar minimize")
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().minimize()
    } catch (err) {
      log.error("title-bar minimize failed", err)
    }
  }
  const handleMax = async () => {
    log.info("title-bar toggle maximize", { wasMaximized: maximized })
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().toggleMaximize()
    } catch (err) {
      log.error("title-bar toggle maximize failed", err)
    }
  }
  const handleClose = async () => {
    log.info("title-bar close")
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().close()
    } catch (err) {
      log.error("title-bar close failed", err)
    }
  }

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-2 text-xs select-none",
        isMac && "pl-20"
      )}
    >
      <div data-tauri-drag-region className="flex flex-1 items-center gap-2 px-2">
        <span data-tauri-drag-region className="font-medium tracking-tight">
          Cognia
        </span>
      </div>
      {!isMac && (
        <div className="flex items-center">
          <TitleBarButton onClick={handleMin} aria-label={t("minimize")}>
            <MinusIcon className="size-3.5" />
          </TitleBarButton>
          <TitleBarButton onClick={handleMax} aria-label={maximized ? t("restore") : t("maximize")}>
            {maximized ? (
              <MinimizeIcon className="size-3.5" />
            ) : (
              <MaximizeIcon className="size-3.5" />
            )}
          </TitleBarButton>
          <TitleBarButton
            onClick={handleClose}
            aria-label={t("close")}
            className="hover:bg-destructive hover:text-destructive-foreground"
          >
            <XIcon className="size-3.5" />
          </TitleBarButton>
        </div>
      )}
    </div>
  )
}

function TitleBarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-10 rounded-none", className)}
      {...props}
    />
  )
}
