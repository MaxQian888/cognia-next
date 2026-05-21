"use client"

// Overview sub-tab — meta rows + lifecycle dates + dependencies + error
// state. Includes a "View raw manifest" Dialog trigger that opens the
// full JSON in a scrollable pre. Replaces the old PluginDetail Overview +
// Manifest + Lifecycle inner tabs by collapsing them into one scrollable
// surface (manifest JSON is one click away rather than its own tab).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CodeIcon, RotateCcwIcon } from "lucide-react"

import { getPlugin } from "@/lib/db/plugins"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { usePluginsStore } from "@/stores/plugins"

interface ManifestShape {
  description?: string
  author?: string | { name: string }
  homepage?: string
  repository?: string
  license?: string
  dependencies?: Record<string, string>
}

export function PluginDetailOverview({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const [manifestOpen, setManifestOpen] = useState(false)

  if (!plugin) return <p className="text-sm text-muted-foreground">{t("notFound")}</p>

  const manifest = plugin.manifest as ManifestShape
  const author =
    typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "")

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Dialog open={manifestOpen} onOpenChange={setManifestOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <CodeIcon className="mr-1.5 size-3.5" />
              {t("rawManifest")}
            </Button>
          </DialogTrigger>
          <DialogContent className="w-[95vw] max-w-3xl max-h-[85vh] flex flex-col p-0">
            <DialogHeader className="px-6 py-4 border-b">
              <DialogTitle>{t("rawManifestTitle")}</DialogTitle>
            </DialogHeader>
            <ScrollArea className="flex-1 min-h-0">
              <pre className="p-4 text-xs font-mono leading-snug">
                {JSON.stringify(plugin.manifest, null, 2)}
              </pre>
            </ScrollArea>
          </DialogContent>
        </Dialog>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRollbackTarget(plugin.id)}
          aria-label={t("rollbackAria", { name: plugin.name })}
        >
          <RotateCcwIcon className="mr-1.5 size-3.5" />
          {t("rollback")}
        </Button>
      </div>

      <Card className="p-3 space-y-1.5">
        <MetaRow label={t("metaId")} value={plugin.id} />
        <MetaRow label={t("metaVersion")} value={plugin.version} />
        <MetaRow label={t("metaType")} value={plugin.type} />
        <MetaRow label={t("metaSource")} value={plugin.source} />
        <MetaRow label={t("metaStatus")} value={plugin.status} />
        {author && <MetaRow label={t("metaAuthor")} value={author} />}
        {manifest.license && <MetaRow label={t("metaLicense")} value={manifest.license} />}
        {manifest.homepage && <MetaRow label={t("metaHomepage")} value={manifest.homepage} />}
        {manifest.repository && <MetaRow label={t("metaRepository")} value={manifest.repository} />}
      </Card>

      <Card className="p-3 space-y-1.5">
        <MetaRow label={t("metaCreatedAt")} value={new Date(plugin.createdAt).toISOString()} />
        <MetaRow label={t("metaUpdatedAt")} value={new Date(plugin.updatedAt).toISOString()} />
        {plugin.lastUsedAt && (
          <MetaRow label={t("metaLastUsedAt")} value={new Date(plugin.lastUsedAt).toISOString()} />
        )}
      </Card>

      {manifest.dependencies && Object.keys(manifest.dependencies).length > 0 && (
        <Card className="p-3 space-y-1">
          <div className="text-xs font-semibold">{t("dependencies")}</div>
          <div className="space-y-0.5">
            {Object.entries(manifest.dependencies).map(([dep, version]) => (
              <div key={dep} className="text-xs flex items-center justify-between">
                <code className="font-mono">{dep}</code>
                <span className="text-muted-foreground">{version}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {plugin.error && (
        <Card className="border-destructive p-3 space-y-1">
          <div className="text-xs font-semibold text-destructive">{t("metaError")}</div>
          <div className="text-xs text-destructive">{plugin.error}</div>
        </Card>
      )}
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-right break-all min-w-0">{value}</span>
    </div>
  )
}
