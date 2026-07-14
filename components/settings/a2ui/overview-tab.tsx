"use client"

// A2UI Overview tab — at-a-glance status, stats, recent apps, and a CTA
// that opens the Hub. No editing happens here; this is a dashboard.

import { useEffect, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, BlocksIcon, ActivityIcon, ClockIcon, BookmarkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { listEvents } from "@/lib/db/a2ui-event-history"
import { useA2UIStore } from "@/stores/a2ui"
import { getAppInstancesCache } from "@/hooks/a2ui/app-builder/persistence"
import type { A2UIAppInstance } from "@/hooks/a2ui/app-builder/types"

export function OverviewTab() {
  const t = useTranslations("settings.a2ui.overview")
  const [apps, setApps] = useState<A2UIAppInstance[]>([])
  const [recentEventCount, setRecentEventCount] = useState(0)

  const surfaces = useA2UIStore((s) => s.surfaces)
  const surfaceCount = Object.keys(surfaces).length
  const readySurfaceCount = Object.values(surfaces).filter((s) => s.ready).length

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Apps live in the localStorage instance store (the same source the Hub
      // reads), NOT the Dexie `a2uiApps` table — nothing writes that table on
      // the create path, so reading it always reported "0 saved apps".
      const instanceList = Array.from(getAppInstancesCache().values()).sort(
        (a, b) => b.lastModified - a.lastModified
      )
      const e = await listEvents({ limit: 200 })
      if (cancelled) return
      setApps(instanceList)
      setRecentEventCount(e.length)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const recent = apps.slice(0, 5)

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <BookmarkIcon className="size-4" /> {t("stats.appsTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{apps.length}</div>
            <CardDescription>{t("stats.appsHelp")}</CardDescription>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ActivityIcon className="size-4" /> {t("stats.surfacesTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {readySurfaceCount}
              <span className="text-sm font-normal text-muted-foreground"> / {surfaceCount}</span>
            </div>
            <CardDescription>{t("stats.surfacesHelp")}</CardDescription>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ClockIcon className="size-4" /> {t("stats.eventsTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{recentEventCount}</div>
            <CardDescription>{t("stats.eventsHelp")}</CardDescription>
          </CardContent>
        </Card>
      </div>

      {/* Recent apps */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t("recent.title")}</h3>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/a2ui">
              <BlocksIcon className="mr-1 size-3.5" /> {t("recent.openHub")}
              <ExternalLinkIcon className="ml-1 size-3" />
            </Link>
          </Button>
        </div>
        {recent.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              {t("recent.empty")}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1">
            {recent.map((app) => (
              <Link
                key={app.id}
                href={`/a2ui?app=${encodeURIComponent(app.id)}`}
                className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{app.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {app.description || app.category || t("recent.noDescription")}
                  </div>
                </div>
                <div className="ml-2 flex items-center gap-2">
                  <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
