"use client"

// Sheet host for the plugin detail surface. Reads the active detail target
// from the plugins store (`detailPluginId`) and unmounts when null. The
// panel content lives in `plugin-detail.tsx` and pulls fresh data straight
// from Dexie via useLiveQuery — no prop-passing of the row.

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { getPlugin } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { PluginDetail } from "./plugin-detail"

export function PluginDetailPanel() {
  const t = useTranslations("plugins.detail")
  const detailPluginId = usePluginsStore((s) => s.detailPluginId)
  const closeDetail = usePluginsStore((s) => s.closeDetail)
  const open = detailPluginId !== null

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeDetail()}>
      <SheetContent className="w-full sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl flex flex-col p-0">
        <SheetHeader className="sticky top-0 z-10 bg-background border-b px-6 py-4">
          {detailPluginId ? (
            <PluginDetailHeader pluginId={detailPluginId} />
          ) : (
            <SheetTitle>{t("loadingTitle")}</SheetTitle>
          )}
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {detailPluginId && <PluginDetail pluginId={detailPluginId} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function PluginDetailHeader({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  if (!plugin) {
    return <SheetTitle>{t("loadingTitle")}</SheetTitle>
  }
  const description = (plugin.manifest as { description?: string })?.description ?? ""
  return (
    <>
      <SheetTitle>
        {plugin.name}{" "}
        <span className="text-muted-foreground text-sm font-normal">v{plugin.version}</span>
      </SheetTitle>
      {description && <SheetDescription>{description}</SheetDescription>}
    </>
  )
}
