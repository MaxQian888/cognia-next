"use client"

// Overview body of the plugin detail pane: identity + lifecycle metadata,
// screenshots, keywords, dependencies, README, verification, error.
//
// Two things this file deliberately does NOT do any more:
//
//   1. **No cards.** Every group used to be a `Card`, so a narrow right pane
//      showed a stack of bordered boxes each with its own padding, and the
//      real content was squeezed into what was left. The groups are now flat
//      sections separated by a hairline and a small label, which is the same
//      information in roughly half the vertical space.
//
//   2. **The raw manifest is not a dialog.** It was a modal that covered the
//      pane you were reading it against. It is now the other half of an
//      in-place toggle, so "details" and "raw JSON" are two views of one
//      surface and switching between them costs one click and no context.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, CodeIcon, InfoIcon, RotateCcwIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Surface } from "@/components/surface/surface"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePluginRow } from "@/hooks/plugins"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginVerificationSnapshot } from "@/types/plugin"
import { usePluginsStore } from "@/stores/plugins"
import { PluginLicense } from "../_shared/plugin-license"
import { PluginScreenshotGallery } from "../_shared/plugin-screenshot-gallery"
import { PluginDependencyPanel } from "../_shared/plugin-dependency-panel"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import type { PluginManifest } from "@/types/plugin"
import { PluginDetailGroup, PluginMetaList, PluginMetaRow } from "./plugin-detail-group"

interface OverviewManifestMeta {
  description?: string
  author?: string | { name: string }
  homepage?: string
  repository?: string
  license?: string
  dependencies?: Record<string, string>
}

type OverviewView = "info" | "manifest"

export function PluginDetailOverview({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const [view, setView] = useState<OverviewView>("info")
  // verificationSnapshot / lastKnownGoodVerification live on the in-memory
  // PluginManager store rather than the Dexie row, so they are subscribed to
  // directly. That is what lets the Overview surface "last successful state"
  // without a schema change to PluginRow.
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
    <div className="space-y-2.5" data-testid="plugin-detail-overview">
      <div className="flex min-w-0 items-center gap-1.5">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={view}
          // A toggle group deselects on a second click. The pane must always
          // show one of the two views, so an empty value keeps the current one.
          onValueChange={(next) => next && setView(next as OverviewView)}
          aria-label={t("viewToggleAria")}
          data-testid="plugin-detail-overview-view"
          className="min-w-0"
        >
          <ToggleGroupItem value="info" className="h-6 gap-1 px-1.5 text-xs">
            <InfoIcon className="size-3.5 shrink-0" />
            <span className="truncate">{t("viewInfo")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="manifest" className="h-6 gap-1 px-1.5 text-xs">
            <CodeIcon className="size-3.5 shrink-0" />
            <span className="truncate">{t("viewManifest")}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        {/* Icon-only until the pane is wide enough for the word. Rollback is
            the rarest control on this surface, so it is the first thing that
            should give up its label rather than push the view toggle off the
            edge of a narrow rail. */}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-xs"
          onClick={() => setRollbackTarget(plugin.id)}
          aria-label={t("rollbackAria", { name: plugin.name })}
          title={t("rollback")}
        >
          <RotateCcwIcon className="size-3.5 shrink-0" />
          <span className="hidden @sm/plugin-detail:inline">{t("rollback")}</span>
        </Button>
      </div>

      {view === "manifest" ? (
        // `min-w-0` on the wrapper is what lets the block scroll its own long
        // lines instead of widening the pane and pushing a horizontal
        // scrollbar onto the whole page.
        <div className="min-w-0 overflow-x-auto" data-testid="plugin-detail-raw-manifest">
          <CodeBlock
            code={JSON.stringify(plugin.manifest, null, 2)}
            language="json"
            filename={`${plugin.id}.json`}
            className="my-0 max-h-[60vh] overflow-auto"
          />
        </div>
      ) : (
        <>
          <PluginMetaList>
            <PluginMetaRow label={t("metaId")} value={plugin.id} mono />
            <PluginMetaRow label={t("metaVersion")} value={plugin.version} mono />
            <PluginMetaRow label={t("metaType")} value={plugin.type} />
            <PluginMetaRow label={t("metaSource")} value={plugin.source} />
            <PluginMetaRow label={t("metaStatus")} value={plugin.status} />
            {author ? <PluginMetaRow label={t("metaAuthor")} value={author} /> : null}
            {manifest.homepage ? (
              <PluginMetaRow label={t("metaHomepage")} value={manifest.homepage} mono />
            ) : null}
            {manifest.repository ? (
              <PluginMetaRow label={t("metaRepository")} value={manifest.repository} mono />
            ) : null}
            {plugin.sourceUrl ? (
              <PluginMetaRow label={t("metaSourceUrl")} value={plugin.sourceUrl} mono />
            ) : null}
            <PluginMetaRow
              label={t("metaCreatedAt")}
              value={formatTimestamp(plugin.createdAt)}
              mono
            />
            <PluginMetaRow
              label={t("metaUpdatedAt")}
              value={formatTimestamp(plugin.updatedAt)}
              mono
            />
            {plugin.lastUsedAt ? (
              <PluginMetaRow
                label={t("metaLastUsedAt")}
                value={formatTimestamp(plugin.lastUsedAt)}
                mono
              />
            ) : null}
          </PluginMetaList>

          {manifest.license || plugin.licenseText ? (
            <PluginLicense license={manifest.license} licenseText={plugin.licenseText} />
          ) : null}

          {/* Both of these existed in the manifest type and had no renderer
              anywhere: a plugin could ship previews and advertise keywords, and
              the product showed neither. */}
          <PluginScreenshotGallery
            screenshots={(plugin.manifest as { screenshots?: string[] }).screenshots}
            pluginRoot={plugin.path}
          />

          <PluginKeywordChips
            keywords={(plugin.manifest as { keywords?: string[] }).keywords}
            onSelect={(keyword) => setFilters({ tag: keyword, query: "" })}
          />

          <PluginDependencyPanel manifest={plugin.manifest as unknown as PluginManifest} />

          {plugin.readme ? (
            <PluginDetailGroup title={t("readme")}>
              <div className="max-h-[50vh] min-w-0 overflow-y-auto text-sm">
                <MarkdownRenderer
                  content={plugin.readme}
                  enableMermaid={false}
                  enableMath={false}
                  rhythm="document"
                />
              </div>
            </PluginDetailGroup>
          ) : null}

          <VerificationGroup
            current={verificationSnapshot}
            lastGood={lastKnownGoodVerification}
            onRollback={() => setRollbackTarget(plugin.id)}
          />

          {plugin.error ? (
            <Surface
              layer="raised"
              radius="control"
              className="border border-destructive/50 px-2.5 py-2"
            >
              <div className="text-xs font-semibold text-destructive">{t("metaError")}</div>
              <div className="mt-0.5 text-xs break-words text-destructive">{plugin.error}</div>
            </Surface>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Local time, minute precision. The old ISO string was 24 unreadable chars. */
function formatTimestamp(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

interface VerificationGroupProps {
  current: PluginVerificationSnapshot | undefined
  lastGood: PluginVerificationSnapshot | undefined
  onRollback: () => void
}

function VerificationGroup({ current, lastGood, onRollback }: VerificationGroupProps) {
  const t = useTranslations("plugins.detail.verification")
  if (!current && !lastGood) return null
  // "Drifted" means the last good snapshot differs from the current one, or
  // the current one is in a failure state. The rollback CTA appears only when
  // there is actually a last-good snapshot to roll back to.
  const drifted =
    !!lastGood &&
    !!current &&
    (current.status !== lastGood.status ||
      current.lastFailureAt !== undefined ||
      current.lastVerifiedAt !== lastGood.lastVerifiedAt)

  return (
    <PluginDetailGroup
      title={t("title")}
      icon={
        drifted ? (
          <ShieldAlertIcon className="size-3.5 text-amber-600" />
        ) : (
          <CheckCircle2Icon className="size-3.5 text-emerald-600" />
        )
      }
      testId="plugin-detail-verification-card"
    >
      <div className="space-y-1.5">
        {current && <VerificationRow label={t("current")} snapshot={current} highlight={drifted} />}
        {lastGood && lastGood.lastVerifiedAt !== current?.lastVerifiedAt && (
          <VerificationRow label={t("lastGood")} snapshot={lastGood} />
        )}
        {drifted && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRollback}>
            <RotateCcwIcon className="mr-1.5 size-3.5" />
            {t("rollbackTo", { version: lastGood?.resolvedVersion ?? "" })}
          </Button>
        )}
      </div>
    </PluginDetailGroup>
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
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
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

/**
 * `manifest.keywords` had no renderer either, and `PluginFilters.tag` was
 * declared and applied by nothing. Making the chips write the tag facet is
 * what turns both from dead declarations into one working affordance.
 */
function PluginKeywordChips({
  keywords,
  onSelect,
}: {
  keywords: string[] | undefined
  onSelect: (keyword: string) => void
}) {
  const t = useTranslations("plugins.detail")
  const values = Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
    : []
  if (values.length === 0) return null
  return (
    <PluginDetailGroup title={t("keywords")} testId="plugin-keyword-chips">
      <div className="flex flex-wrap gap-1.5">
        {values.map((keyword) => (
          <Badge
            key={keyword}
            asChild
            variant="outline"
            className="cursor-pointer text-xs hover:bg-accent"
          >
            <button
              type="button"
              onClick={() => onSelect(keyword)}
              aria-label={t("keywordFilterAria", { keyword })}
            >
              {keyword}
            </button>
          </Badge>
        ))}
      </div>
    </PluginDetailGroup>
  )
}
