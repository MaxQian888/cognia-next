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

import { useMemo, useState } from "react"
import * as LucideIcons from "lucide-react"
import { ChevronRightIcon, SearchIcon, type LucideIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { groupedCatalog, searchCatalog, type NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { WorkflowNodeCategory } from "@/types/workflow/visual"

export const NODE_DRAG_MIME = "application/x-workflow-kind"

const CATEGORY_LABELS: Record<WorkflowNodeCategory, string> = {
  trigger: "Triggers",
  action: "Actions",
  ai: "AI",
  flow: "Flow control",
  data: "Data",
  io: "I/O",
  annotation: "Annotations",
}

const CATEGORY_HINTS: Record<WorkflowNodeCategory, string> = {
  trigger: "Start a workflow",
  action: "Operate on cognia entities",
  ai: "LLM primitives",
  flow: "Control execution flow",
  data: "Reshape data between steps",
  io: "Network in/out",
  annotation: "Visual notes only",
}

export function NodeSearchSidebar({
  className,
  onAddNodeAtCenter,
}: {
  className?: string
  /** Called when the user clicks an entry instead of dragging it. */
  onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
}) {
  const [query, setQuery] = useState("")
  const groups = useMemo(() => (query.trim() ? null : groupedCatalog()), [query])
  const flatResults = useMemo(() => (query.trim() ? searchCatalog(query) : null), [query])

  return (
    <aside
      className={cn("flex h-full w-full flex-col border-r bg-card/50 backdrop-blur", className)}
      data-testid="workflow-node-sidebar"
      aria-label="Node palette"
    >
      <div className="border-b px-3 py-3">
        <div className="relative">
          <SearchIcon className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            className="pl-9 h-9"
            aria-label="Search nodes"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {flatResults ? (
          <div className="p-2 space-y-1">
            {flatResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No nodes match &ldquo;{query}&rdquo;
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
              title={CATEGORY_LABELS[group.category]}
              hint={CATEGORY_HINTS[group.category]}
              entries={group.entries}
              onAddNodeAtCenter={onAddNodeAtCenter}
            />
          ))
        )}
      </div>
      <div className="border-t px-3 py-2 text-[10px] text-muted-foreground leading-relaxed">
        Drag a node to the canvas, or click to drop it at the center.
      </div>
    </aside>
  )
}

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
          <span className="flex-1 min-w-0 truncate">{entry.label}</span>
          {entry.desktopOnly ? (
            <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Desktop
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <p className="font-medium">{entry.label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
      </TooltipContent>
    </Tooltip>
  )
}
