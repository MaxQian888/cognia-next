"use client"

/**
 * The glance layout editor (ADR-0225 §12): reorder the shown modules by drag
 * (or Space + arrows on the grip), pick each one's size, hide it, and add the
 * hidden ones back. One component for the tray panel's in-place edit mode and
 * the settings editor, so both mean the same thing by an edit, and for the
 * phone's layout, where each shown module also carries a home-screen pin.
 *
 * It owns no state. Every interaction hands the caller a whole new entry list
 * built by `lib/glance/layout-edit.ts`; persisting it (and marking the layout
 * `custom`) is the caller's job.
 */

import { createElement, useCallback, useId, useMemo, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
import { EyeOffIcon, GripVerticalIcon, HouseIcon, PlusIcon } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { useReorderAnnouncements } from "@/components/shell/nav-sortable"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { hideEntry, reorderVisible, resizeEntry, showEntry } from "@/lib/glance/layout-edit"
import { GLANCE_MODULES } from "@/lib/glance/registry"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import { cn } from "@/lib/utils"
import type { GlanceLayoutEntry, GlanceModuleId, GlanceModuleSize } from "@/types/glance/layout"

export interface GlanceLayoutEditorProps<E extends GlanceLayoutEntry = GlanceLayoutEntry> {
  entries: readonly E[]
  onChange: (entries: E[]) => void
  /** Modules this surface can show; others are neither listed nor addable. */
  available: readonly GlanceModuleId[]
  /**
   * `compact` for the 320–460 px panel (short size labels, tight rows),
   * `comfortable` for settings, `touch` for a phone (44 px targets).
   */
  density?: "compact" | "comfortable" | "touch"
  /**
   * The phone's home pin (ADR-0225 §9): a toggle on every shown row. The
   * caller turns a toggle into a new entry list (`pinEntryHome`).
   */
  home?: {
    isPinned: (id: GlanceModuleId) => boolean
    onToggle: (id: GlanceModuleId, home: boolean) => void
  }
}

/**
 * A module's icon. `createElement` rather than a capitalized local: the icon
 * is looked up from data, not a component this file defines per render.
 */
function moduleIcon(id: GlanceModuleId) {
  const icon = resolveIcon(GLANCE_MODULES[id].icon)
  return icon
    ? createElement(icon, {
        "aria-hidden": true,
        className: "size-3.5 shrink-0 text-muted-foreground",
      })
    : null
}

interface RowProps {
  entry: GlanceLayoutEntry
  label: string
  density: "compact" | "comfortable" | "touch"
  pinned: boolean | null
  onPin: (home: boolean) => void
  onResize: (size: GlanceModuleSize) => void
  onHide: () => void
}

/** Icon-button classes per density. */
function iconButton(density: RowProps["density"]): string {
  return cn(
    "grid shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    density === "touch" ? "size-10" : "size-6"
  )
}

function SortableRow({ entry, label, density, pinned, onPin, onResize, onHide }: RowProps) {
  const compact = density === "compact"
  const touch = density === "touch"
  const t = useTranslations("glance.editor")
  const tSizes = useTranslations("glance.sizes")
  const def = GLANCE_MODULES[entry.id]
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition }

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`glance-editor-row-${entry.id}`}
      className={cn(
        "flex items-center gap-1.5 bg-popover",
        compact ? "py-1" : touch ? "py-0.5" : "py-1.5",
        isDragging && "relative z-10 rounded-md shadow-md"
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={t("reorder", { module: label })}
        className={cn(iconButton(density), "cursor-grab touch-none active:cursor-grabbing")}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon aria-hidden className={touch ? "size-4" : "size-3.5"} />
      </button>
      {moduleIcon(entry.id)}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          compact ? "text-[12.5px]" : touch ? "text-[15px]" : "text-sm"
        )}
      >
        {label}
      </span>
      {def.sizes.length > 1 ? (
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={entry.size}
          aria-label={t("size", { module: label })}
          onValueChange={(value) => {
            // Radix reports "" when the pressed item is pressed again; a size
            // is never unset, so that is a no-op rather than a reset.
            if (value) onResize(value as GlanceModuleSize)
          }}
          className="shrink-0"
        >
          {def.sizes.map((size) => (
            <ToggleGroupItem
              key={size}
              value={size}
              aria-label={tSizes(size)}
              title={tSizes(size)}
              className={cn(
                compact
                  ? "h-6 min-w-6 px-1.5 text-[11px]"
                  : touch
                    ? "h-9 min-w-9 px-2 text-[13px]"
                    : "h-7 px-2 text-xs"
              )}
            >
              {compact || touch ? tSizes(`short.${size}`) : tSizes(size)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {pinned !== null ? (
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={t("homePin", { module: label })}
          title={t(pinned ? "homePinned" : "homeUnpinned")}
          data-testid={`glance-editor-home-${entry.id}`}
          onClick={() => onPin(!pinned)}
          className={cn(iconButton(density), pinned && "text-primary hover:text-primary")}
        >
          <HouseIcon aria-hidden className={touch ? "size-4" : "size-3.5"} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t("hide", { module: label })}
        title={t("hide", { module: label })}
        onClick={onHide}
        className={iconButton(density)}
      >
        <EyeOffIcon aria-hidden className={touch ? "size-4" : "size-3.5"} />
      </button>
    </li>
  )
}

export function GlanceLayoutEditor<E extends GlanceLayoutEntry = GlanceLayoutEntry>({
  entries,
  onChange,
  available,
  density = "comfortable",
  home,
}: GlanceLayoutEditorProps<E>) {
  const t = useTranslations("glance.editor")
  const tGlance = useTranslations("glance")
  const compact = density === "compact"
  const touch = density === "touch"
  const headingId = useId()

  const labelOf = useCallback(
    (id: string) => tGlance(GLANCE_MODULES[id as GlanceModuleId].labelKey),
    [tGlance]
  )
  const shown = useMemo(
    () => entries.filter((e) => !e.hidden && available.includes(e.id)),
    [entries, available]
  )
  const addable = useMemo(
    () => entries.filter((e) => e.hidden && available.includes(e.id)),
    [entries, available]
  )
  const shownIds = useMemo(() => shown.map((e) => e.id), [shown])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const { announcements, instructions } = useReorderAnnouncements(shownIds, labelOf, {
    keyboard: true,
  })

  const onDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      shownIds,
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) onChange(reorderVisible(entries, next as GlanceModuleId[]))
  }

  const heading = cn(
    "font-semibold text-muted-foreground",
    compact ? "text-[11.5px]" : "text-xs uppercase tracking-wide"
  )

  return (
    <div className={cn(compact ? "space-y-3" : "space-y-4")} data-testid="glance-layout-editor">
      <section aria-labelledby={`${headingId}-shown`}>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <h3 id={`${headingId}-shown`} className={heading}>
            {t("shown")}
          </h3>
          <span className="text-[11px] text-muted-foreground">{t("shownHint")}</span>
        </div>
        {shown.length === 0 ? (
          <p className="py-2 text-[12px] text-muted-foreground">{t("shownEmpty")}</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{ announcements, screenReaderInstructions: { draggable: instructions } }}
          >
            <SortableContext items={shownIds} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-border/60">
                {shown.map((entry) => (
                  <SortableRow
                    key={entry.id}
                    entry={entry}
                    label={labelOf(entry.id)}
                    density={density}
                    pinned={home ? home.isPinned(entry.id) : null}
                    onPin={(pin) => home?.onToggle(entry.id, pin)}
                    onResize={(size) => onChange(resizeEntry(entries, entry.id, size))}
                    onHide={() => onChange(hideEntry(entries, entry.id))}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <section aria-labelledby={`${headingId}-add`}>
        <h3 id={`${headingId}-add`} className={cn(heading, "mb-1")}>
          {t("add")}
        </h3>
        {addable.length === 0 ? (
          <p className="py-1 text-[12px] text-muted-foreground">{t("addEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {addable.map((entry) => {
              const label = labelOf(entry.id)
              return (
                <li
                  key={entry.id}
                  data-testid={`glance-editor-hidden-${entry.id}`}
                  className={cn(
                    "flex items-center gap-1.5",
                    compact ? "py-1" : touch ? "py-0.5" : "py-1.5"
                  )}
                >
                  <span aria-hidden className={cn("shrink-0", touch ? "size-10" : "size-6")} />
                  {moduleIcon(entry.id)}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-muted-foreground",
                      compact ? "text-[12.5px]" : touch ? "text-[15px]" : "text-sm"
                    )}
                  >
                    {label}
                  </span>
                  <button
                    type="button"
                    aria-label={t("addModule", { module: label })}
                    onClick={() => onChange(showEntry(entries, entry.id, available))}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[var(--link)] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      touch ? "h-10 px-3 text-[14px]" : "h-6 text-[12px]"
                    )}
                  >
                    <PlusIcon aria-hidden className="size-3.5" />
                    {t("addShort")}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
