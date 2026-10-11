"use client"

// Overview tab of the plugin detail pane: what the plugin is and where it came
// from, its README, and how its last verification went.
//
// Layout follows the pane, not the window (`@container/plugin-detail`):
//
//   narrow (< 42rem)              wide (>= 42rem)
//   ┌──────────────────┐          ┌──────────────────────┬──────────┐
//   │ last error       │          │ last error (full width)          │
//   │ About            │          ├──────────────────────┬──────────┤
//   │ Dependencies     │          │ Screenshots          │ About    │
//   │ Keywords         │          │ README               │ Deps     │
//   │ Screenshots      │          │ VS Code compat       │ Keywords │
//   │ README …         │          │ Verification         │          │
//   └──────────────────┘          └──────────────────────┴──────────┘
//
// On a narrow pane the short facts come first because a long README would
// otherwise bury them; on a wide one they become a side column, which is the
// reading layout of every package registry page.
//
// What this file deliberately does not do:
//
//   1. **No cards.** Every group is a flat `PluginDetailGroup` (a hairline and
//      a small label). The last error is a left-ruled callout, not a box.
//   2. **No in-pane scrollers.** The README used to sit in a `max-h-[50vh]`
//      box inside the pane's own scroller; two nested scrollbars on a phone is
//      a gesture trap. The pane scrolls, the README is just content.
//   3. **No duplicate header facts.** Name, version and the enable state are
//      the header's. The runtime status stays here because it is a different
//      fact from the header's pill (the live runtime state, not the stored one).
//   4. **The raw manifest is a face of this tab, not a dialog.** The header's
//      actions menu switches to it ("View raw manifest"); a Back control
//      returns. A modal used to cover the pane you were reading it against.
//
// Rollback lives in the header's actions menu, where it is offered only when a
// backup of another version exists. The Verification group keeps its own
// "Roll back to vX" call to action because it only appears when there IS a
// last-good snapshot that differs from the current one.

import { useFormatter, useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type {
  PluginStatus,
  PluginType,
  PluginVerificationSnapshot,
  PluginVerificationStage,
} from "@/types/plugin"
import { usePluginsStore } from "@/stores/plugins"
import { PluginLicense } from "../_shared/plugin-license"
import { PluginScreenshotGallery } from "../_shared/plugin-screenshot-gallery"
import { PluginDependencyPanel } from "../_shared/plugin-dependency-panel"
import { parsePluginSource } from "../plugin-source-badge"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import type { PluginManifest } from "@/types/plugin"
import { PluginDetailGroup, PluginMetaList, PluginMetaRow } from "./plugin-detail-group"
import { PluginVscodeCompatSection } from "./plugin-vscode-compat-section"

interface OverviewManifestMeta {
  description?: string
  author?: string | { name: string }
  homepage?: string
  repository?: string | { url?: string }
  license?: string
  dependencies?: Record<string, string>
}

export interface PluginDetailOverviewProps {
  pluginId: string
  /**
   * Called after a keyword chip applied a library filter. The phone drawer
   * and the tablet sheet pass a dismiss here: they cover the list the filter
   * just changed, so leaving them open hides the result of the tap.
   */
  onFilterApplied?: () => void
}

export function PluginDetailOverview({ pluginId, onFilterApplied }: PluginDetailOverviewProps) {
  const t = useTranslations("plugins.detail")
  const tSource = useTranslations("plugins.source")
  const format = useFormatter()
  const rowState = usePluginRow(pluginId)
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const openDetail = usePluginsStore((s) => s.openDetail)
  const view = usePluginsStore((s) => s.detailOverviewView)
  const setView = usePluginsStore((s) => s.setDetailOverviewView)
  // verificationSnapshot / lastKnownGoodVerification live on the in-memory
  // PluginManager store rather than the Dexie row, so they are subscribed to
  // directly. That is what lets the Overview surface "last successful state"
  // without a schema change to PluginRow.
  const verificationSnapshot = usePluginStore((s) => s.plugins[pluginId]?.verificationSnapshot)
  // The row's `status` is written at discovery and never follows the runtime
  // (enable writes `enabled` / `lifecycle`), so an enabled plugin read
  // "discovered" here. The runtime store is the live value.
  const liveStatus = usePluginStore((s) => s.plugins[pluginId]?.status)
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

  if (view === "manifest") {
    return (
      <div className="space-y-2" data-testid="plugin-detail-overview">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 h-7 gap-1 px-2 text-xs pointer-coarse:h-10"
            onClick={() => setView("info")}
            data-testid="plugin-detail-back-to-info"
          >
            <ArrowLeftIcon className="size-3.5" />
            {t("backToInfo")}
          </Button>
          <h3 className="truncate text-xs font-semibold text-muted-foreground">
            {t("rawManifestTitle")}
          </h3>
        </div>
        {/* `min-w-0` on the wrapper is what lets the block scroll its own long
            lines instead of widening the pane. No height cap: the pane is the
            vertical scroller. */}
        <div className="min-w-0 overflow-x-auto" data-testid="plugin-detail-raw-manifest">
          <CodeBlock
            code={JSON.stringify(plugin.manifest, null, 2)}
            language="json"
            filename={`${plugin.id}.json`}
            className="my-0"
          />
        </div>
      </div>
    )
  }

  // A status the host knows gets its label; anything else prints as stored.
  const status = liveStatus ?? plugin.status
  const manifest = plugin.manifest as OverviewManifestMeta
  const author =
    typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "")
  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
  const knownSource = parsePluginSource(plugin.source)
  const formatTimestamp = (value: number): string => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return t("unknownDate")
    return format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })
  }

  return (
    <div
      className="grid grid-cols-1 gap-x-6 gap-y-4 @2xl/plugin-detail:grid-cols-[minmax(0,1fr)_17rem]"
      data-testid="plugin-detail-overview"
    >
      {plugin.error ? (
        <div
          className="border-l-2 border-destructive pl-2.5 @2xl/plugin-detail:col-span-2"
          role="alert"
          data-testid="plugin-detail-last-error"
        >
          <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <CircleAlertIcon className="size-3.5" aria-hidden />
            {t("metaError")}
          </div>
          <div className="mt-0.5 text-xs break-words text-destructive">{plugin.error}</div>
        </div>
      ) : null}

      {/* Facts column. First on a narrow pane, the right column on a wide one. */}
      <aside
        className="min-w-0 space-y-4 @2xl/plugin-detail:col-start-2 @2xl/plugin-detail:row-start-[var(--about-row)]"
        style={{ ["--about-row" as string]: plugin.error ? 2 : 1 }}
        aria-label={t("aboutTitle")}
        data-testid="plugin-detail-about"
      >
        <PluginDetailGroup title={t("aboutTitle")}>
          <PluginMetaList>
            <PluginMetaRow label={t("metaId")} value={plugin.id} mono />
            <PluginMetaRow
              label={t("metaStatus")}
              value={RUNTIME_STATUSES.has(status) ? t(`runtimeStatus.${status}` as never) : status}
            />
            <PluginMetaRow
              label={t("metaType")}
              value={
                PLUGIN_TYPES.has(plugin.type as PluginType)
                  ? t(`pluginType.${plugin.type}` as never)
                  : plugin.type
              }
            />
            <PluginMetaRow
              label={t("metaSource")}
              value={knownSource ? tSource(knownSource as never) : plugin.source}
            />
            {author ? <PluginMetaRow label={t("metaAuthor")} value={author} /> : null}
            {manifest.homepage ? (
              <PluginMetaRow
                label={t("metaHomepage")}
                value={displayUrl(manifest.homepage)}
                href={safeHttpUrl(manifest.homepage)}
                mono
              />
            ) : null}
            {repository ? (
              <PluginMetaRow
                label={t("metaRepository")}
                value={displayUrl(repository)}
                href={safeHttpUrl(repository)}
                mono
              />
            ) : null}
            {plugin.sourceUrl ? (
              <PluginMetaRow label={t("metaSourceUrl")} value={plugin.sourceUrl} mono />
            ) : null}
            <PluginMetaRow label={t("metaCreatedAt")} value={formatTimestamp(plugin.createdAt)} />
            <PluginMetaRow label={t("metaUpdatedAt")} value={formatTimestamp(plugin.updatedAt)} />
            {plugin.lastUsedAt ? (
              <PluginMetaRow
                label={t("metaLastUsedAt")}
                value={formatTimestamp(plugin.lastUsedAt)}
              />
            ) : null}
          </PluginMetaList>
          {manifest.license || plugin.licenseText ? (
            <div className="mt-2">
              <PluginLicense license={manifest.license} licenseText={plugin.licenseText} />
            </div>
          ) : null}
        </PluginDetailGroup>

        <PluginDependencyPanel
          manifest={plugin.manifest as unknown as PluginManifest}
          onOpenDependency={openDetail}
        />

        <PluginKeywordChips
          keywords={(plugin.manifest as { keywords?: string[] }).keywords}
          onSelect={(keyword) => {
            setFilters({ tag: keyword, query: "" })
            onFilterApplied?.()
          }}
        />
      </aside>

      {/* Reading column. */}
      <div
        className="min-w-0 space-y-4 @2xl/plugin-detail:col-start-1 @2xl/plugin-detail:row-start-[var(--about-row)]"
        style={{ ["--about-row" as string]: plugin.error ? 2 : 1 }}
        data-testid="plugin-detail-reading"
      >
        {/* Both of these existed in the manifest type and had no renderer
            anywhere: a plugin could ship previews and advertise keywords, and
            the product showed neither. */}
        <PluginScreenshotGallery
          screenshots={(plugin.manifest as { screenshots?: string[] }).screenshots}
          pluginRoot={plugin.path}
        />

        {plugin.readme ? (
          <PluginDetailGroup title={t("readme")} testId="plugin-detail-readme">
            {/* A readable measure on a wide pane; long code lines scroll in
                their own blocks rather than widening the column. */}
            <div className="max-w-[72ch] min-w-0 text-sm">
              <MarkdownRenderer
                content={plugin.readme}
                enableMermaid={false}
                enableMath={false}
                rhythm="document"
              />
            </div>
          </PluginDetailGroup>
        ) : (
          // Not the manifest description: the header already shows it in the
          // user's language, and repeating the raw (often English) text here
          // printed it twice in two languages.
          <p className="text-xs text-muted-foreground" data-testid="plugin-detail-no-readme">
            {t("noReadme")}
          </p>
        )}

        <PluginVscodeCompatSection manifest={plugin.manifest as unknown as PluginManifest} />

        <VerificationGroup
          current={verificationSnapshot}
          lastGood={lastKnownGoodVerification}
          onRollback={() => setRollbackTarget(plugin.id)}
        />
      </div>
    </div>
  )
}

/** Drop the scheme and a trailing slash: the column is narrow and the link says the rest. */
function displayUrl(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

/**
 * Only http(s) values become links. A manifest is author-supplied, so a
 * `javascript:` homepage must render as text, never as an href.
 */
function safeHttpUrl(value: string): string | undefined {
  const normalized = value.startsWith("git+") ? value.slice(4) : value
  return /^https?:\/\//i.test(normalized) ? normalized : undefined
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
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs pointer-coarse:h-10"
            onClick={onRollback}
          >
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
  const tDetail = useTranslations("plugins.detail")
  const format = useFormatter()
  const when = (iso: string): string => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime())
      ? iso
      : format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })
  }
  const statusLabel = RUNTIME_STATUSES.has(snapshot.status)
    ? tDetail(`runtimeStatus.${snapshot.status}` as never)
    : snapshot.status
  const stageLabel = VERIFICATION_STAGES.has(snapshot.verificationStage)
    ? t(`stage.${snapshot.verificationStage}` as never)
    : snapshot.verificationStage
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant={highlight ? "destructive" : "outline"} className="text-[10px]">
          {statusLabel}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {stageLabel}
        </Badge>
        {snapshot.resolvedVersion && (
          <span className="font-mono text-muted-foreground">
            {tDetail("versionLabel", { version: snapshot.resolvedVersion })}
          </span>
        )}
        <span className="text-muted-foreground">
          {snapshot.lastSuccessfulAt
            ? t("lastSuccessfulAt", { date: when(snapshot.lastSuccessfulAt) })
            : snapshot.lastFailureAt
              ? t("lastFailureAt", { date: when(snapshot.lastFailureAt) })
              : t("verifiedAt", { date: when(snapshot.lastVerifiedAt) })}
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
            className="cursor-pointer text-xs hover:bg-accent pointer-coarse:min-h-8 pointer-coarse:px-2.5"
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

const RUNTIME_STATUSES: ReadonlySet<string> = new Set<PluginStatus>([
  "discovered",
  "installed",
  "loading",
  "loaded",
  "enabling",
  "enabled",
  "disabling",
  "disabled",
  "suspended",
  "unloading",
  "error",
  "updating",
])

const PLUGIN_TYPES: ReadonlySet<PluginType> = new Set<PluginType>([
  "frontend",
  "python",
  "hybrid",
  "wasm",
  "vscode-extension",
])

const VERIFICATION_STAGES: ReadonlySet<string> = new Set<PluginVerificationStage>([
  "manifest_validation",
  "compatibility",
  "installation",
  "activation",
  "runtime_execution",
  "reload",
  "cleanup",
])
