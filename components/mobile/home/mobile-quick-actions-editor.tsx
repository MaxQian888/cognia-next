"use client"

/**
 * Editor for the mobile home customization. Two lists — Active (drag-reorder +
 * remove) and Available (add) — plus section visibility switches and a "Restore
 * defaults" button. dnd-kit setup mirrors
 * `components/shell/sidebar-customizer.tsx`.
 *
 * Rendered inside a bottom `Sheet` by `mobile-quick-actions.tsx`.
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
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import type { MobileQuickActionItem } from "@/lib/shell/mobile-home-nav"
import { DEFAULT_MOBILE_HOME_LAYOUT, type MobileHomeSectionId } from "@/types/shell/mobile-home"
import { useMobileHomeLayout } from "./use-mobile-home-layout"

/** Sections the user can toggle off (quickActions is implicit — empty = hidden). */
const TOGGLEABLE_SECTIONS: readonly MobileHomeSectionId[] = ["recents", "activeRuns"]

export function MobileQuickActionsEditor(): React.ReactElement {
  const t = useTranslations("mobile.home.customize")
  const tActions = useTranslations("mobile.home.actions")
  const tSections = useTranslations("mobile.home.sections")
  const {
    resolved,
    layout,
    addAction,
    removeAction,
    reorderActions,
    hideSection,
    showSection,
    isSectionHidden,
    reset,
  } = useMobileHomeLayout()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      resolved.active.map((i) => i.id),
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) void reorderActions(next)
  }

  const isDefault =
    JSON.stringify({
      quickActions: resolved.active.map((i) => i.id),
      hiddenSections: layout.hiddenSections,
    }) === JSON.stringify(DEFAULT_MOBILE_HOME_LAYOUT)

  return (
    <div className="space-y-4" data-testid="mobile-quick-actions-editor">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void reset()}
          disabled={isDefault}
          data-testid="mobile-home-editor-reset"
        >
          <RotateCcwIcon className="mr-1.5 size-3.5" />
          {t("restoreDefaults")}
        </Button>
      </div>

      <ListSection title={t("active")} hint={t("dragHint")}>
        {resolved.active.length === 0 ? (
          <EmptyRow label={t("activeEmpty")} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={resolved.active.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-1">
                {resolved.active.map((item) => (
                  <ActiveRow
                    key={item.id}
                    item={item}
                    label={tActions(item.i18nKey)}
                    removeLabel={t("remove")}
                    onRemove={() => void removeAction(item.id)}
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
          <ul className="space-y-1">
            {resolved.available.map((item) => (
              <StaticRow
                key={item.id}
                item={item}
                label={tActions(item.i18nKey)}
                actionLabel={t("add")}
                ActionIcon={PlusIcon}
                onAction={() => void addAction(item.id)}
                testKey="add"
              />
            ))}
          </ul>
        )}
      </ListSection>

      <ListSection title={t("sections")}>
        <ul className="space-y-1">
          {TOGGLEABLE_SECTIONS.map((id) => {
            const visible = !isSectionHidden(id)
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded border bg-card px-3 py-2"
                data-testid={`mobile-home-editor-section-${id}`}
              >
                <span className="flex-1 truncate text-sm">{tSections(id)}</span>
                <Switch
                  checked={visible}
                  onCheckedChange={(next) => void (next ? showSection(id) : hideSection(id))}
                  aria-label={tSections(id)}
                  data-testid={`mobile-home-editor-section-toggle-${id}`}
                />
              </li>
            )
          })}
        </ul>
      </ListSection>
    </div>
  )
}

function ListSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function EmptyRow({ label }: { label: string }) {
  return (
    <p className="rounded border bg-muted/30 p-3 text-center text-xs italic text-muted-foreground">
      {label}
    </p>
  )
}

function RowLabel({ item, label }: { item: MobileQuickActionItem; label: string }) {
  return (
    <>
      <item.Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{label}</span>
    </>
  )
}

function ActiveRow({
  item,
  label,
  removeLabel,
  onRemove,
}: {
  item: MobileQuickActionItem
  label: string
  removeLabel: string
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`mobile-home-editor-active-${item.id}`}
      data-elevation={isDragging ? "2" : undefined}
      className={cn(
        "flex items-center gap-2 rounded border bg-card px-2 py-1.5",
        // `data-elevation` rather than `shadow-md`: the elevation scale is
        // what a style pack retunes, and a flat pack has no way to reach a raw
        // shadow utility. The row lifting under a finger is exactly the depth
        // cue that pack is choosing about.
        isDragging && "opacity-50"
      )}
    >
      <button
        type="button"
        className="flex size-7 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label={`drag ${label}`}
        data-testid={`mobile-home-editor-handle-${item.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <RowLabel item={item} label={label} />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={removeLabel}
        onClick={onRemove}
        data-testid={`mobile-home-editor-remove-${item.id}`}
      >
        <MinusIcon className="size-4" />
      </Button>
    </li>
  )
}

function StaticRow({
  item,
  label,
  actionLabel,
  ActionIcon,
  onAction,
  testKey,
}: {
  item: MobileQuickActionItem
  label: string
  actionLabel: string
  ActionIcon: React.ComponentType<{ className?: string }>
  onAction: () => void
  testKey: string
}) {
  return (
    <li
      className="flex items-center gap-2 rounded border bg-card px-2 py-1.5"
      data-testid={`mobile-home-editor-row-${item.id}`}
    >
      <RowLabel item={item} label={label} />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={actionLabel}
        onClick={onAction}
        data-testid={`mobile-home-editor-${testKey}-${item.id}`}
      >
        <ActionIcon className="size-4" />
      </Button>
    </li>
  )
}
