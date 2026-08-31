"use client"

/**
 * Left-rail search sidebar for the workflow editor. Lists every node kind
 * grouped by category, with a search box and drag-to-canvas affordance.
 *
 * The drag mechanism uses the HTML5 DnD API: each draggable carries the
 * node kind on a custom MIME type (`application/x-workflow-kind`), which the
 * canvas's `onDrop` handler reads and converts into an `addNode` call. This
 * is the same pattern the official React Flow Drag-and-Drop example uses.
 */

import { memo, useMemo, useState, useSyncExternalStore } from "react"
import { useShallow } from "zustand/react/shallow"
import * as LucideIcons from "lucide-react"
import { ChevronRightIcon, SearchIcon, StarIcon, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  groupedCatalog,
  searchCatalog,
  subscribePluginCatalog,
  getPluginCatalogSnapshot,
  nodeCatalogEntry,
  type CatalogGroup,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import type { PaletteSection } from "@/lib/workflow/nodes/palette-sections"
import { tNodeField } from "@/lib/workflow/i18n/node-translate"
import { CapabilityBadge, useMissingNodeCapabilities } from "./capability-badge"
import { usePalettePreferencesStore } from "@/stores/workflow"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export const NODE_DRAG_MIME = "application/x-workflow-kind"

// useSyncExternalStore identity-stable getter for the plugin catalog. The
// snapshot returned by `getPluginCatalogSnapshot` is a fresh array on every
// call, but identity matters less than reactivity here: any change to the
// plugin catalog notifies subscribers, and the sidebar re-renders. We pin a
// `getServerSnapshot` to an empty array so SSR/static builds don't crash.
const SERVER_SNAPSHOT: readonly NodeCatalogEntry[] = []
function getServerSnapshot(): readonly NodeCatalogEntry[] {
  return SERVER_SNAPSHOT
}

export const NodeSearchSidebar = memo(function NodeSearchSidebar({
  className,
  onAddNodeAtCenter,
  embedded = false,
}: {
  className?: string
  /** Called when the user clicks an entry instead of dragging it. */
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
  /**
   * Drop the side-rail chrome (`border-r bg-card/50 backdrop-blur`) and the
   * drag-hint footer. Set when hosted in a surface that owns its own
   * background and where drag-to-canvas isn't the affordance — e.g. the
   * mobile node-palette bottom sheet (tap-to-add only).
   */
  embedded?: boolean
}) {
  const t = useTranslations("workflows.sidebar")
  // Root translator so both built-in (`workflows.nodes.*`) and plugin
  // (`plugin.<id>.workflow.nodes.*`) node strings resolve via `tNodeField`.
  const tRootSearch = useTranslations()
  const [query, setQuery] = useState("")
  // Subscribe to the plugin catalog so newly-registered plugin nodes appear
  // in the sidebar without a page reload. The snapshot identity changes on
  // every plugin add/remove, which forces the memoized groups/flatResults
  // below to recompute.
  const pluginEntries = useSyncExternalStore(
    subscribePluginCatalog,
    getPluginCatalogSnapshot,
    getServerSnapshot
  )
  const groups = useMemo(() => {
    // pluginEntries is read indirectly through groupedCatalog; tracking its
    // identity here forces the recompute when the plugin catalog mutates.
    void pluginEntries
    return query.trim() ? null : groupedCatalog()
  }, [query, pluginEntries])
  const flatResults = useMemo(() => {
    void pluginEntries
    if (!query.trim()) return null
    // Search the localized strings too so e.g. zh-CN users can find nodes by
    // their translated palette names — including plugin nodes that ship their
    // own translations. `tNodeField` falls back to "" for un-localized kinds,
    // which searchCatalog tolerates.
    return searchCatalog(query, {
      getText: (entry) => ({
        label: tNodeField(tRootSearch, {
          kind: entry.kind,
          pluginId: entry.pluginId,
          field: "label",
          fallback: "",
        }),
        description: tNodeField(tRootSearch, {
          kind: entry.kind,
          pluginId: entry.pluginId,
          field: "description",
          fallback: "",
        }),
      }),
    })
  }, [query, pluginEntries, tRootSearch])

  // Favorite + recent kinds (persisted). Resolve each stored kind to a live
  // catalog entry and drop any that no longer exist (e.g. a plugin node whose
  // plugin was uninstalled) by intersecting with the kinds visible in the
  // current grouped catalog.
  const favoriteKinds = usePalettePreferencesStore(useShallow((s) => s.favoriteNodeKinds))
  const recentKinds = usePalettePreferencesStore(useShallow((s) => s.recentlyUsedNodeKinds))
  const validKinds = useMemo(
    () => (groups ? new Set(groups.flatMap((g) => g.entries.map((e) => e.kind))) : null),
    [groups]
  )
  const favoriteEntries = useMemo(
    () =>
      validKinds
        ? favoriteKinds
            .filter((k) => validKinds.has(k as WorkflowNodeKind))
            .map((k) => nodeCatalogEntry(k as WorkflowNodeKind))
        : [],
    [favoriteKinds, validKinds]
  )
  const recentEntries = useMemo(
    () =>
      validKinds
        ? recentKinds
            .filter((k) => validKinds.has(k as WorkflowNodeKind))
            .map((k) => nodeCatalogEntry(k as WorkflowNodeKind))
        : [],
    [recentKinds, validKinds]
  )

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col",
        !embedded && "border-r bg-card/50 backdrop-blur",
        className
      )}
      data-testid="workflow-node-sidebar"
      aria-label={t("searchPlaceholder")}
    >
      <div className="border-b px-3 py-3">
        <div className="relative">
          <SearchIcon className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9 h-9"
            aria-label={t("searchPlaceholder")}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {flatResults ? (
          <div className="p-2 space-y-1">
            {flatResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("noMatches")}
              </p>
            ) : (
              flatResults.map((entry) => (
                <NodeChip key={entry.kind} entry={entry} onAddNodeAtCenter={onAddNodeAtCenter} />
              ))
            )}
          </div>
        ) : (
          <>
            <PinnedNodeGroup
              title={t("favorites")}
              hint={t("favoritesHint")}
              emptyHint={t("noFavorites")}
              entries={favoriteEntries}
              onAddNodeAtCenter={onAddNodeAtCenter}
            />
            {recentEntries.length > 0 ? (
              <PinnedNodeGroup
                title={t("recent")}
                hint={t("recentHint")}
                emptyHint={t("noRecent")}
                entries={recentEntries}
                onAddNodeAtCenter={onAddNodeAtCenter}
              />
            ) : null}
            {groups?.map((group) => (
              <NodeCategoryGroup
                key={group.category}
                title={t(`category.${group.category}`)}
                hint={t(`hint.${group.category}`)}
                entries={group.entries}
                sections={group.sections}
                sectionTitle={(section) => t(`section.${section}`)}
                onAddNodeAtCenter={onAddNodeAtCenter}
              />
            ))}
          </>
        )}
      </div>
      {embedded ? null : (
        <div className="border-t px-3 py-2 text-[10px] text-muted-foreground leading-relaxed">
          {t("dragHint")}
        </div>
      )}
    </aside>
  )
})

function NodeCategoryGroup({
  title,
  hint,
  entries,
  sections,
  sectionTitle,
  onAddNodeAtCenter,
}: {
  title: string
  hint: string
  entries: NodeCatalogEntry[]
  /** Present only for a category too big to read as one list (today: actions). */
  sections?: CatalogGroup["sections"]
  sectionTitle?: (section: PaletteSection) => string
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
}) {
  const [open, setOpen] = useState(true)
  if (entries.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors">
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">{title}</span>
        <span className="text-muted-foreground/70 font-normal">{entries.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="px-6 pb-1 text-[11px] text-muted-foreground/70">{hint}</p>
        {/* content-visibility skips layout/paint for groups scrolled out of
            view — the palette renders the full catalog unvirtualized, so this
            is the cheap 80% of a virtual list for plugin-heavy catalogs. */}
        <div className="px-2 pb-1 space-y-1 [content-visibility:auto] [contain-intrinsic-size:auto_300px]">
          {sections && sectionTitle
            ? sections.map(({ section, entries: sectionEntries }) => (
                <div key={section} data-testid={`wf-palette-section-${section}`}>
                  <p className="px-1 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    {sectionTitle(section)}
                  </p>
                  <div className="space-y-1">
                    {sectionEntries.map((entry) => (
                      <NodeChip
                        key={entry.kind}
                        entry={entry}
                        onAddNodeAtCenter={onAddNodeAtCenter}
                      />
                    ))}
                  </div>
                </div>
              ))
            : entries.map((entry) => (
                <NodeChip key={entry.kind} entry={entry} onAddNodeAtCenter={onAddNodeAtCenter} />
              ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A favorites / recently-used section. Unlike `NodeCategoryGroup` this renders
 * an empty-state hint when it has no entries so the affordance stays
 * discoverable (used for the always-visible Favorites group).
 */
function PinnedNodeGroup({
  title,
  hint,
  emptyHint,
  entries,
  onAddNodeAtCenter,
}: {
  title: string
  hint: string
  emptyHint: string
  entries: NodeCatalogEntry[]
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors">
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <span className="flex-1 text-left">{title}</span>
        {entries.length > 0 ? (
          <span className="text-muted-foreground/70 font-normal">{entries.length}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="px-6 pb-1 text-[11px] text-muted-foreground/70">{hint}</p>
        {entries.length === 0 ? (
          <p className="px-6 pb-2 text-[11px] text-muted-foreground/60">{emptyHint}</p>
        ) : (
          <div className="px-2 pb-1 space-y-1">
            {entries.map((entry) => (
              <NodeChip key={entry.kind} entry={entry} onAddNodeAtCenter={onAddNodeAtCenter} />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// Memoized: catalog entries are stable references, so a favorite toggle (or
// any parent re-render from search/preference churn) only re-renders the
// chips whose own subscribed slice actually changed.
const NodeChip = memo(function NodeChip({
  entry,
  onAddNodeAtCenter,
}: {
  entry: NodeCatalogEntry
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
}) {
  const t = useTranslations("workflows.sidebar")
  const tRoot = useTranslations()
  const label = tNodeField(tRoot, {
    kind: entry.kind,
    pluginId: entry.pluginId,
    field: "label",
    fallback: entry.label,
  })
  const description = tNodeField(tRoot, {
    kind: entry.kind,
    pluginId: entry.pluginId,
    field: "description",
    fallback: entry.description,
  })
  const Icon =
    (LucideIcons as unknown as Record<string, LucideIcon>)[entry.iconName] ?? LucideIcons.Box
  const capabilityInfo = useMissingNodeCapabilities(entry)
  const isFavorite = usePalettePreferencesStore((s) => s.favoriteNodeKinds.includes(entry.kind))
  const toggleFavorite = usePalettePreferencesStore((s) => s.toggleFavorite)
  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(NODE_DRAG_MIME, entry.kind)
    e.dataTransfer.setData("text/plain", entry.kind)
    e.dataTransfer.effectAllowed = "move"
  }
  return (
    <div className="group/chip relative flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            draggable
            onDragStart={handleDragStart}
            onClick={() => onAddNodeAtCenter?.(entry)}
            className="flex w-full items-center gap-2.5 rounded-md border border-transparent py-2 pl-2.5 pr-8 text-left text-sm transition hover:border-border hover:bg-accent active:scale-[0.99]"
            data-testid={`wf-sidebar-${entry.kind}`}
            data-kind={entry.kind}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate">{label}</span>
            {entry.desktopOnly ? (
              <span className="text-[9px] uppercase tracking-wide text-wf-status-running">
                {t("desktopOnly")}
              </span>
            ) : capabilityInfo ? (
              <CapabilityBadge info={capabilityInfo} />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p className="font-medium">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          {capabilityInfo ? (
            <p className="text-xs text-wf-status-running mt-0.5">{capabilityInfo.tooltip}</p>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleFavorite(entry.kind)
        }}
        aria-label={isFavorite ? t("removeFromFavorites") : t("addToFavorites")}
        aria-pressed={isFavorite}
        data-testid={`wf-sidebar-fav-${entry.kind}`}
        className={cn(
          "absolute right-1.5 rounded p-1 text-muted-foreground/60 transition hover:text-amber-500 focus-visible:opacity-100",
          isFavorite ? "opacity-100 text-amber-500" : "opacity-0 group-hover/chip:opacity-100"
        )}
      >
        <StarIcon className={cn("size-3.5", isFavorite && "fill-current")} aria-hidden="true" />
      </button>
    </div>
  )
})
