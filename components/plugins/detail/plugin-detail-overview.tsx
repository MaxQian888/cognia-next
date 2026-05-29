"use client"

// Overview sub-tab — meta rows + lifecycle dates + dependencies + error
// state. Includes a "View raw manifest" Dialog trigger that opens the
// full JSON in a scrollable pre. Replaces the old PluginDetail Overview +
// Manifest + Lifecycle inner tabs by collapsing them into one scrollable
// surface (manifest JSON is one click away rather than its own tab).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, CodeIcon, RotateCcwIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginVerificationSnapshot } from "@/types/plugin"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { usePluginsStore } from "@/stores/plugins"
import { PluginLicense } from "../_shared/plugin-license"
import { PluginDependencyPanel } from "../_shared/plugin-dependency-panel"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import type { PluginManifest } from "@/types/plugin"

interface OverviewManifestMeta {
  description?: string
  author?: string | { name: string }
  homepage?: string
  repository?: string
  license?: string
  dependencies?: Record<string, string>
}

export function PluginDetailOverview({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const [manifestOpen, setManifestOpen] = useState(false)
  // verificationSnapshot / lastKnownGoodVerification live on the in-memory
  // PluginManager store, not the Dexie row — subscribe directly so the
  // Overview surfaces "last successful state" without needing a schema
  // change to PluginRow.
  const verificationSnapshot = usePluginStore((s) => s.plugins[pluginId]?.verificationSnapshot)
  const lastKnownGoodVerification = usePluginStore(
    (s) => s.plugins[pluginId]?.lastKnownGoodVerification
  )

  if (rowState.state === "loading") {
    return (
      <div className="space-y-3" data-testid="plugin-detail-overview-loading" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (rowState.state === "not-found") {
    return <p className="text-sm text-muted-foreground">{t("notFound")}</p>
  }
  const plugin = rowState.row
  const manifest = plugin.manifest as OverviewManifestMeta
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
        {manifest.homepage && <MetaRow label={t("metaHomepage")} value={manifest.homepage} />}
        {manifest.repository && <MetaRow label={t("metaRepository")} value={manifest.repository} />}
        {plugin.sourceUrl && <MetaRow label={t("metaSourceUrl")} value={plugin.sourceUrl} />}
        {(manifest.license || plugin.licenseText) && (
          <PluginLicense
            license={manifest.license}
            licenseText={plugin.licenseText}
            className="pt-1"
          />
        )}
      </Card>

      <Card className="p-3 space-y-1.5">
        <MetaRow label={t("metaCreatedAt")} value={new Date(plugin.createdAt).toISOString()} />
        <MetaRow label={t("metaUpdatedAt")} value={new Date(plugin.updatedAt).toISOString()} />
        {plugin.lastUsedAt && (
          <MetaRow label={t("metaLastUsedAt")} value={new Date(plugin.lastUsedAt).toISOString()} />
        )}
      </Card>

      <PluginDependencyPanel manifest={plugin.manifest as unknown as PluginManifest} />

      {plugin.readme && (
        <Card className="p-3">
          <div className="text-xs font-semibold mb-2">{t("readme")}</div>
          <ScrollArea className="max-h-[50vh]">
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm pr-2">
              <MarkdownRenderer content={plugin.readme} enableMermaid={false} enableMath={false} />
            </div>
          </ScrollArea>
        </Card>
      )}

      <VerificationCard
        current={verificationSnapshot}
        lastGood={lastKnownGoodVerification}
        onRollback={() => setRollbackTarget(plugin.id)}
      />

      {plugin.error && (
        <Card className="border-destructive p-3 space-y-1">
          <div className="text-xs font-semibold text-destructive">{t("metaError")}</div>
          <div className="text-xs text-destructive">{plugin.error}</div>
        </Card>
      )}
    </div>
  )
}

interface VerificationCardProps {
  current: PluginVerificationSnapshot | undefined
  lastGood: PluginVerificationSnapshot | undefined
  onRollback: () => void
}

function VerificationCard({ current, lastGood, onRollback }: VerificationCardProps) {
  const t = useTranslations("plugins.detail.verification")
  if (!current && !lastGood) return null
  // "Drifted" — last good differs from current OR current is in a failure
  // state. Surfaces a rollback CTA only when there's actually a last-good
  // snapshot to roll back to.
  const drifted =
    !!lastGood &&
    !!current &&
    (current.status !== lastGood.status ||
      current.lastFailureAt !== undefined ||
      current.lastVerifiedAt !== lastGood.lastVerifiedAt)

  return (
    <Card className="p-3 space-y-2" data-testid="plugin-detail-verification-card">
      <div className="flex items-center gap-2">
        {drifted ? (
          <ShieldAlertIcon className="size-4 text-amber-600" />
        ) : (
          <CheckCircle2Icon className="size-4 text-emerald-600" />
        )}
        <div className="text-xs font-semibold">{t("title")}</div>
      </div>
      {current && <VerificationRow label={t("current")} snapshot={current} highlight={drifted} />}
      {lastGood && lastGood.lastVerifiedAt !== current?.lastVerifiedAt && (
        <VerificationRow label={t("lastGood")} snapshot={lastGood} />
      )}
      {drifted && (
        <div className="pt-1">
          <Button size="sm" variant="outline" onClick={onRollback}>
            <RotateCcwIcon className="size-3.5 mr-1.5" />
            {t("rollbackTo", { version: lastGood?.resolvedVersion ?? "" })}
          </Button>
        </div>
      )}
    </Card>
  )
}

function VerificationRow({
  label,
  snapshot,
  highlight,
}: {
  label: string
  snapshot: PluginVerificationSnapshot
  highlight?: boolean
}) {
  const t = useTranslations("plugins.detail.verification")
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 justify-end">
        <Badge variant={highlight ? "destructive" : "outline"} className="text-[10px]">
          {snapshot.status}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {snapshot.verificationStage}
        </Badge>
        {snapshot.resolvedVersion && (
          <span className="font-mono text-muted-foreground">v{snapshot.resolvedVersion}</span>
        )}
        <span className="text-muted-foreground">
          {snapshot.lastSuccessfulAt
            ? t("lastSuccessfulAt", { date: snapshot.lastSuccessfulAt })
            : snapshot.lastFailureAt
              ? t("lastFailureAt", { date: snapshot.lastFailureAt })
              : t("verifiedAt", { date: snapshot.lastVerifiedAt })}
        </span>
      </div>
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
