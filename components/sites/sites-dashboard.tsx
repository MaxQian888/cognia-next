"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useSiteLiveData } from "@/hooks/sites/use-site-live-data"
import { isTauri } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import { useProjectStore } from "@/stores/project/project-store"
import { NewSiteDialog } from "./new-site-dialog"
import { SitePublishView } from "./site-publish-view"

/**
 * Sites shell: a master/detail frame around the progressive publish flow. The
 * site list and the selected site's data come from a single live query
 * ({@link useSiteLiveData}), so builds/deploys reflect instantly without a
 * manual refresh. Selection is derived — the hook resolves the pinned id, else
 * the first site — which avoids a set-state-in-effect. Desktop-only: authoring,
 * provider credentials, and previews stay on the local host.
 */
export function SitesDashboard() {
  const t = useTranslations("sites")
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const loadProjects = useProjectStore((state) => state.load)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const actorAccountId = unlockedAccountId ?? "local-user"
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const live = useSiteLiveData(pinnedId)
  const selectedSite = live.sites.find((site) => site.id === live.selectedId) ?? null

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  if (!isTauri()) {
    return (
      <Alert className="m-6">
        <CloudIcon />
        <AlertTitle>{t("desktopOnly.title")}</AlertTitle>
        <AlertDescription>{t("desktopOnly.description")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r lg:w-72">
        <div className="p-4">
          <h1 className="font-semibold">{t("title")}</h1>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-3">
          <div className="space-y-2 pb-4">
            {live.loading ? (
              [0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full rounded-lg" />)
            ) : live.sites.length === 0 ? (
              <p className="px-1 py-4 text-xs text-muted-foreground">{t("sidebarEmpty")}</p>
            ) : (
              live.sites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => setPinnedId(site.id)}
                  aria-current={site.id === live.selectedId}
                  className={`w-full rounded-lg border p-3 text-left transition-colors motion-reduce:transition-none ${
                    site.id === live.selectedId ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{site.name}</span>
                    <Badge variant={site.lifecycle === "active" ? "default" : "secondary"}>
                      {t(`lifecycle.${site.lifecycle}`)}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {site.providerConfig.workerName}
                  </p>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
        <Separator />
        <div className="p-3">
          <NewSiteDialog
            projects={projects}
            activeProjectId={activeProjectId}
            actorAccountId={actorAccountId}
            onCreated={setPinnedId}
          />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-6">
        {selectedSite ? (
          <SitePublishView
            key={selectedSite.id}
            site={selectedSite}
            versions={live.versions}
            deployments={live.deployments}
            environments={live.environments}
            resources={live.resources}
            operations={live.operations}
            events={live.events}
            actorAccountId={actorAccountId}
            onDeleted={() => setPinnedId(null)}
          />
        ) : live.loading ? (
          <div className="mx-auto max-w-4xl space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in">
            {t("empty")}
          </div>
        )}
      </main>
    </div>
  )
}
