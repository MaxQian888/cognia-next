"use client"

/**
 * The quick module's content editor on a phone: which shortcuts the grid
 * shows and in what order (ADR-0225 §9). Two lists, Active (drag to reorder,
 * remove) and Available (add), and a reset to the default four.
 *
 * Owns no state: every change hands the caller the whole new id list, which
 * the caller saves as `mobileGlanceLayout.shortcuts`. dnd-kit setup mirrors
 * `components/shell/sidebar-customizer.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { GripVerticalIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react"
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

import { Button } from "@/components/ui/button"
import { DEFAULT_GLANCE_MOBILE_SHORTCUTS } from "@/lib/glance/mobile-layout"
import {
  getMobileQuickActionCatalog,
  resolveMobileShortcuts,
  type MobileQuickActionItem,
} from "@/lib/shell/mobile-home-nav"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import { cn } from "@/lib/utils"

export interface MobileShortcutsEditorProps {
  shortcuts: readonly string[]
  onChange: (shortcuts: string[]) => void
}

export function MobileShortcutsEditor({ shortcuts, onChange }: MobileShortcutsEditorProps) {
  const t = useTranslations("mobile.home.customize")
  const tActions = useTranslations("mobile.home.actions")
  const catalog = React.useMemo(() => getMobileQuickActionCatalog(), [])
  const resolved = React.useMemo(
    () => resolveMobileShortcuts(catalog, shortcuts),
    [catalog, shortcuts]
  )
  const activeIds = resolved.active.map((item) => item.id)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      activeIds,
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) onChange(next)
  }

  const isDefault = JSON.stringify(activeIds) === JSON.stringify(DEFAULT_GLANCE_MOBILE_SHORTCUTS)

  return (
    <div className="space-y-4" data-testid="mobile-shortcuts-editor">
      <ListSection
        title={t("active")}
        hint={t("dragHint")}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={() => onChange([...DEFAULT_GLANCE_MOBILE_SHORTCUTS])}
            disabled={isDefault}
            data-testid="mobile-shortcuts-reset"
          >
            <RotateCcwIcon aria-hidden className="size-3.5" />
            {t("restoreDefaults")}
          </Button>
        }
      >
        {resolved.active.length === 0 ? (
          <EmptyRow label={t("activeEmpty")} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={activeIds} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-border/60">
                {resolved.active.map((item) => (
                  <ActiveRow
                    key={item.id}
                    item={item}
                    label={tActions(item.i18nKey)}
                    dragLabel={t("dragLabel", { action: tActions(item.i18nKey) })}
                    removeLabel={t("removeLabel", { action: tActions(item.i18nKey) })}
                    onRemove={() => onChange(activeIds.filter((id) => id !== item.id))}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </ListSection>

      <ListSection title={t("available")}>
        {resolved.available.length === 0 ? (
          <EmptyRow label={t("availableEmpty")} />
        ) : (
          <ul className="divide-y divide-border/60">
            {resolved.available.map((item) => (
              <li
                key={item.id}
                className="flex min-h-11 items-center gap-2"
                data-testid={`mobile-shortcuts-available-${item.id}`}
              >
                <span aria-hidden className="size-10 shrink-0" />
                <item.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[15px] text-muted-foreground">
                  {tActions(item.i18nKey)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10"
                  aria-label={t("addLabel", { action: tActions(item.i18nKey) })}
                  onClick={() => onChange([...activeIds, item.id])}
                  data-testid={`mobile-shortcuts-add-${item.id}`}
                >
                  <PlusIcon aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ListSection>
    </div>
  )
}

function ListSection({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {hint ? <span className="flex-1 text-[11px] text-muted-foreground">{hint}</span> : null}
        {action}
      </div>
      {children}
    </section>
  )
}

function EmptyRow({ label }: { label: string }) {
  return <p className="py-3 text-center text-xs text-muted-foreground">{label}</p>
}

function ActiveRow({
  item,
  label,
  dragLabel,
  removeLabel,
  onRemove,
}: {
  item: MobileQuickActionItem
  label: string
  dragLabel: string
  removeLabel: string
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`mobile-shortcuts-active-${item.id}`}
      className={cn(
        "flex min-h-11 items-center gap-2 bg-popover",
        isDragging && "relative z-10 rounded-md shadow-md"
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="grid size-10 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={dragLabel}
        data-testid={`mobile-shortcuts-handle-${item.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon aria-hidden className="size-4" />
      </button>
      <item.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[15px]">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-10"
        aria-label={removeLabel}
        onClick={onRemove}
        data-testid={`mobile-shortcuts-remove-${item.id}`}
      >
        <MinusIcon aria-hidden className="size-4" />
      </Button>
    </li>
  )
}
