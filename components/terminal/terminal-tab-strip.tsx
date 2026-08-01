"use client"

/**
 * Horizontal tab strip shared by the desktop dock and the mobile
 * full-screen terminal screen. Presentational — owns no state, no
 * spawn logic, no store reads. Both shells filter tabs to the active
 * project upstream and pass the array in.
 *
 * Edge controls are slotted (`leading` / `trailing`) so the strip doesn't need
 * to know about transport variants or shell affordances.
 *
 * ## Two rendering branches
 *
 * Without `onReorder` (the mobile screen) the strip keeps its per-tab
 * enter/exit motion. With `onReorder` (the dock) the tabs become a dnd-kit
 * sortable list instead, and the motion is dropped: dnd-kit and `motion` both
 * own `transform` on the same node and motion wins, which would freeze a tab
 * mid-drag. A live drag transform is worth more than a 160 ms fade — and the
 * shell that has no drag keeps the fade.
 */

import * as React from "react"
import type { MouseEvent, ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { MoreHorizontalIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useElementWidth } from "@/hooks/use-element-width"
import { hiddenTabIds, overflowEdges } from "@/lib/terminal/tab-overflow"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import { cn } from "@/lib/utils"
import { displayTitle, type TerminalSessionRow } from "@/stores/terminal/terminal-store"

import { TerminalTab } from "./terminal-tab"

export interface TerminalTabStripProps {
  tabs: TerminalSessionRow[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Right-click handler — wired to the context menu in Wave 3A. */
  onContextMenu?: (row: TerminalSessionRow, e: MouseEvent<HTMLElement>) => void
  /** Left-aligned controls (the dock's move grip). */
  leading?: ReactNode
  /** Right-aligned controls (spawn, close-panel, connection badge…). */
  trailing?: ReactNode
  /**
   * Wrap each rendered tab — the dock uses this to give every tab its own
   * context-menu trigger. Identity by default.
   */
  renderTabWrapper?: (row: TerminalSessionRow, tab: ReactNode) => ReactNode
  /** Sessions under renderer backpressure; forwarded to each tab. */
  throttledIds?: ReadonlySet<string>
  /** Enables drag-to-reorder. Receives the complete new anchor-id order. */
  onReorder?: (orderedIds: string[]) => void
  /** Optional className override for the outer strip container. */
  className?: string
  /** Optional `data-testid` override. Defaults to `"terminal-tab-strip"`. */
  testId?: string
}

export function TerminalTabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  leading,
  trailing,
  renderTabWrapper,
  throttledIds,
  onReorder,
  className,
  testId = "terminal-tab-strip",
}: TerminalTabStripProps) {
  const t = useTranslations("terminal.dock")
  const { reduce, durationScale } = useFlowMotion()

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const tabRefs = React.useRef(new Map<string, HTMLElement>())
  const [hidden, setHidden] = React.useState<string[]>([])
  const [edges, setEdges] = React.useState({ start: false, end: false })
  // Re-measure when the strip resizes (window, dock move, sidebar toggle).
  const stripWidth = useElementWidth(scrollRef)

  const measure = React.useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    const box = node.getBoundingClientRect()
    const rects = tabs.flatMap((row) => {
      const el = tabRefs.current.get(row.id)
      if (!el) return []
      const r = el.getBoundingClientRect()
      return [{ id: row.id, left: r.left, right: r.right }]
    })
    setHidden(hiddenTabIds({ left: box.left, right: box.right }, rects))
    setEdges(overflowEdges(node.scrollLeft, node.scrollWidth, node.clientWidth))
  }, [tabs])

  React.useEffect(() => {
    measure()
  }, [measure, stripWidth])

  const setTabRef = React.useCallback((id: string, node: HTMLElement | null) => {
    if (node) tabRefs.current.set(id, node)
    else tabRefs.current.delete(id)
  }, [])

  const tabNode = React.useCallback(
    (row: TerminalSessionRow, extra?: Record<string, unknown>) => {
      // Resolved inside the callback so a caller passing an inline
      // `renderTabWrapper` doesn't invalidate this memo on every render.
      const wrap = renderTabWrapper ?? ((_row: TerminalSessionRow, tab: ReactNode) => tab)
      return wrap(
        row,
        <TerminalTab
          row={row}
          active={row.id === activeId}
          onSelect={onSelect}
          onClose={onClose}
          throttled={throttledIds?.has(row.id)}
          onContextMenu={onContextMenu ? (e) => onContextMenu(row, e) : undefined}
          {...extra}
        />
      )
    },
    [renderTabWrapper, activeId, onSelect, onClose, throttledIds, onContextMenu]
  )

  const hiddenRows = tabs.filter((row) => hidden.includes(row.id))

  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b bg-muted/30 px-1.5 pt-1.5",
        className === undefined && "min-w-0"
      )}
      data-testid={testId}
    >
      {leading ? <div className="flex shrink-0 items-center pb-1">{leading}</div> : null}
      <div
        ref={scrollRef}
        onScroll={measure}
        data-testid={`${testId}-scroll`}
        data-overflow-start={edges.start ? "true" : "false"}
        data-overflow-end={edges.end ? "true" : "false"}
        className={cn(
          className ?? "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto",
          // Fade whichever edge still has tabs beyond it, so a clipped strip
          // reads as scrollable rather than as the whole list.
          edges.start && "[mask-image:linear-gradient(to_right,transparent,black_16px)]",
          edges.end && "[mask-image:linear-gradient(to_left,transparent,black_16px)]",
          edges.start &&
            edges.end &&
            "[mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)]"
        )}
      >
        {onReorder ? (
          <SortableStrip tabs={tabs} onReorder={onReorder}>
            {(row) => (
              <SortableTab key={row.id} id={row.id} setTabRef={setTabRef}>
                {(sortableProps) => tabNode(row, sortableProps)}
              </SortableTab>
            )}
          </SortableStrip>
        ) : (
          <AnimatePresence initial={false}>
            {tabs.map((row) => (
              <motion.div
                key={row.id}
                ref={(node) => setTabRef(row.id, node)}
                className="shrink-0"
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: reduce ? 0 : 0.16 * durationScale, ease: "easeOut" }}
              >
                {tabNode(row)}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      {hiddenRows.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 p-0"
              aria-label={t("overflowTabs")}
              title={t("overflowTabs")}
              data-testid="terminal-tab-overflow"
            >
              <MoreHorizontalIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {hiddenRows.map((row) => (
              <DropdownMenuItem
                key={row.id}
                data-testid="terminal-tab-overflow-item"
                data-id={row.id}
                onSelect={() => {
                  onSelect(row.id)
                  tabRefs.current
                    .get(row.id)
                    ?.scrollIntoView({ block: "nearest", inline: "center" })
                }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mr-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                    row.status === "running"
                      ? "bg-blue-500"
                      : row.status === "exited"
                        ? row.exitCode === 0
                          ? "bg-emerald-500"
                          : "bg-red-500"
                        : "bg-muted-foreground/60"
                  )}
                />
                <span className="truncate">{displayTitle(row)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {trailing ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pb-1 pr-1">{trailing}</div>
      ) : null}
    </div>
  )
}

/** dnd-kit wrapper for the reorderable branch. */
function SortableStrip({
  tabs,
  onReorder,
  children,
}: {
  tabs: TerminalSessionRow[]
  onReorder: (orderedIds: string[]) => void
  children: (row: TerminalSessionRow) => ReactNode
}) {
  const ids = React.useMemo(() => tabs.map((row) => row.id), [tabs])
  // A short activation distance keeps a plain click on a tab a *selection*.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id ? String(event.over.id) : null
      // Same reorder maths the bar / rail customizers use; it returns `null`
      // for a drop that changes nothing.
      const next = applyDragReorder(ids, String(event.active.id), overId)
      if (next) onReorder(next)
    },
    [ids, onReorder]
  )

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
        {tabs.map((row) => children(row))}
      </SortableContext>
    </DndContext>
  )
}

function SortableTab({
  id,
  setTabRef,
  children,
}: {
  id: string
  setTabRef: (id: string, node: HTMLElement | null) => void
  children: (props: Record<string, unknown>) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        setTabRef(id, node)
      }}
      className={cn("shrink-0", isDragging && "z-10 opacity-80")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {children({ ...attributes, ...listeners })}
    </div>
  )
}

export default TerminalTabStrip
