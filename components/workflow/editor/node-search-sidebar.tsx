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
import * as LucideIcons from "lucide-react"
import { ChevronRightIcon, SearchIcon, type LucideIcon } from "lucide-react"
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
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import { tNode } from "@/lib/workflow/i18n/node-translate"

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
    return query.trim() ? searchCatalog(query) : null
  }, [query, pluginEntries])

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
          groups?.map((group) => (
            <NodeCategoryGroup
              key={group.category}
              title={t(`category.${group.category}`)}
              hint={t(`hint.${group.category}`)}
              entries={group.entries}
              onAddNodeAtCenter={onAddNodeAtCenter}
            />
          ))
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
  onAddNodeAtCenter,
}: {
  title: string
  hint: string
  entries: NodeCatalogEntry[]
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
        <div className="px-2 pb-1 space-y-1">
          {entries.map((entry) => (
            <NodeChip key={entry.kind} entry={entry} onAddNodeAtCenter={onAddNodeAtCenter} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function NodeChip({
  entry,
  onAddNodeAtCenter,
}: {
  entry: NodeCatalogEntry
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
}) {
  const t = useTranslations("workflows.sidebar")
  const tNodes = useTranslations("workflows.nodes")
  const label = tNode(tNodes, `${entry.kind}.label`, entry.label)
  const description = tNode(tNodes, `${entry.kind}.description`, entry.description)
  const Icon =
    (LucideIcons as unknown as Record<string, LucideIcon>)[entry.iconName] ?? LucideIcons.Box
  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(NODE_DRAG_MIME, entry.kind)
    e.dataTransfer.setData("text/plain", entry.kind)
    e.dataTransfer.effectAllowed = "move"
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          draggable
          onDragStart={handleDragStart}
          onClick={() => onAddNodeAtCenter?.(entry)}
          className="flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm transition hover:border-border hover:bg-accent active:scale-[0.99]"
          data-testid={`wf-sidebar-${entry.kind}`}
          data-kind={entry.kind}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate">{label}</span>
          {entry.desktopOnly ? (
            <span className="text-[9px] uppercase tracking-wide text-wf-status-running">
              {t("desktopOnly")}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </TooltipContent>
    </Tooltip>
  )
}
