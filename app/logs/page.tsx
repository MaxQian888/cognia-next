"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LogPanel } from "@/components/logging/log-panel"

/**
 * Dedicated full-page Log Panel route.
 *
 * Mirrors the structure of `app/skills/page.tsx`. The panel is rendered with
 * its full feature set (stats dashboard + density timeline + virtualized
 * list). Users land here from:
 *   - the settings link card under Settings → Observability → Logs
 *   - the tray menu "Open Log Panel" item (emits `tray://open-logs`)
 *   - the View → Open Log Panel application menu item
 *   - the global Ctrl+Shift+L shortcut
 */
export default function LogsPage() {
  const t = useTranslations("logging.panel")

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button asChild variant="ghost" size="sm" className="-ml-1">
          <Link href="/">
            <ChevronLeftIcon className="h-4 w-4 mr-1" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="text-base font-semibold">{t("logs")}</h1>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">
        <LogPanel
          showStats
          showTimeline
          includeAgentTrace={false}
          defaultAutoRefresh={false}
          refreshInterval={2000}
        />
      </div>
    </div>
  )
}
