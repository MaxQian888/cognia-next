"use client"

/**
 * Reusable editor for the desktop left-rail (`GuildRail`) layout. Three lists —
 * Pinned (drag-reorderable), More (overflow), Hidden — with per-row move
 * actions plus a "Restore defaults" button. Shared by the standalone customize
 * dialog (`sidebar-customize-dialog.tsx`) and the Settings section
 * (`components/settings/sidebar/sidebar-section.tsx`).
 *
 * dnd-kit setup mirrors `components/settings/ocr/tabs/ocr-platform-overrides-tab.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import {
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  PinIcon,
  RotateCcwIcon,
} from "lucide-react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useSidebarLayout } from "./use-sidebar-layout"
import { applyDragReorder, type SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

export function SidebarCustomizer(): React.ReactElement {
  const t = useTranslations("desktop.guildRail")
  const { resolved, pin, unpin, hide, show, reorderPinned, reset } = useSidebarLayout()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      resolved.pinned.map((i) => i.id),
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) void reorderPinned(next)
  }

  // "Restore defaults" is a no-op when the live layout already matches the
  // factory default (on desktop, where the full catalog is present). On mobile
  // the desktop-only items are absent from the catalog but may linger in the
  // stored arrays, so compare the resolved pinned ids instead of raw arrays.
  const isDefault =
    JSON.stringify({
      pinned: resolved.pinned.map((i) => i.id),
      hidden: resolved.hidden.map((i) => i.id),
    }) === JSON.stringify(DEFAULT_SIDEBAR_LAYOUT)

  return (
    <div className="space-y-4" data-testid="sidebar-customizer">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void reset()}
          disabled={isDefault}
          data-testid="sidebar-customizer-reset"
        >
          <RotateCcwIcon className="mr-1.5 h-3.5 w-3.5" />
          {t("customize.restoreDefaults")}
        </Button>
      </div>

      <ListSection title={t("customize.pinned")} hint={t("customize.dragHint")}>
        {resolved.pinned.length === 0 ? (
          <EmptyRow label={t("customize.pinnedEmpty")} />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={resolved.pinned.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-1">
                {resolved.pinned.map((item) => (
                  <PinnedRow
                    key={item.id}
                    item={item}
                    label={t(item.i18nKey)}
                    moveLabel={t("customize.moveToMore")}
                    hideLabel={t("customize.hideItem")}
                    onMoveToMore={() => void unpin(item.id)}
                    onHide={() => void hide(item.id)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </ListSection>

      <ListSection title={t("customize.more")}>
        {resolved.overflow.length === 0 ? (
          <EmptyRow label={t("customize.moreEmpty")} />
        ) : (
          <ul className="space-y-1">
            {resolved.overflow.map((item) => (
              <StaticRow
                key={item.id}
                item={item}
                label={t(item.i18nKey)}
                actions={[
                  {
                    key: "pin",
                    label: t("customize.pin"),
                    Icon: PinIcon,
                    onClick: () => void pin(item.id),
                  },
                  {
                    key: "hide",
                    label: t("customize.hideItem"),
                    Icon: EyeOffIcon,
                    onClick: () => void hide(item.id),
                  },
                ]}
              />
            ))}
          </ul>
        )}
      </ListSection>

      <ListSection title={t("customize.hidden")}>
        {resolved.hidden.length === 0 ? (
          <EmptyRow label={t("customize.hiddenEmpty")} />
        ) : (
          <ul className="space-y-1">
            {resolved.hidden.map((item) => (
              <StaticRow
                key={item.id}
                item={item}
                muted
                label={t(item.i18nKey)}
                actions={[
                  {
                    key: "show",
                    label: t("customize.showItem"),
                    Icon: EyeIcon,
                    onClick: () => void show(item.id),
                  },
                  {
                    key: "pin",
                    label: t("customize.pin"),
                    Icon: PinIcon,
                    onClick: () => void pin(item.id),
                  },
                ]}
              />
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

function RowShell({
  children,
  muted,
  dragging,
  testId,
  innerRef,
  style,
}: {
  children: React.ReactNode
  muted?: boolean
  dragging?: boolean
  testId: string
  innerRef?: (node: HTMLElement | null) => void
  style?: React.CSSProperties
}) {
  return (
    <li
      ref={innerRef}
      style={style}
      data-testid={testId}
      className={cn(
        "flex items-center gap-2 rounded border bg-card px-2 py-1.5",
        muted && "opacity-70",
        dragging && "opacity-50 shadow-md"
      )}
    >
      {children}
    </li>
  )
}

interface RowAction {
  key: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
  onClick: () => void
}

function IconAction({ action, itemId }: { action: RowAction; itemId: string }) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={action.label}
          onClick={action.onClick}
          data-testid={`sidebar-customizer-${action.key}-${itemId}`}
        >
          <action.Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  )
}

function RowLabel({ item, label }: { item: SidebarCatalogItem; label: string }) {
  return (
    <>
      <item.Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{label}</span>
    </>
  )
}

function PinnedRow({
  item,
  label,
  moveLabel,
  hideLabel,
  onMoveToMore,
  onHide,
}: {
  item: SidebarCatalogItem
  label: string
  moveLabel: string
  hideLabel: string
  onMoveToMore: () => void
  onHide: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <RowShell
      innerRef={setNodeRef}
      style={style}
      dragging={isDragging}
      testId={`sidebar-customizer-pinned-${item.id}`}
    >
      <button
        type="button"
        className="flex size-6 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label={`drag ${label}`}
        data-testid={`sidebar-customizer-handle-${item.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <RowLabel item={item} label={label} />
      <IconAction
        action={{ key: "unpin", label: moveLabel, Icon: EllipsisIcon, onClick: onMoveToMore }}
        itemId={item.id}
      />
      <IconAction
        action={{ key: "hide", label: hideLabel, Icon: EyeOffIcon, onClick: onHide }}
        itemId={item.id}
      />
    </RowShell>
  )
}

function StaticRow({
  item,
  label,
  actions,
  muted,
}: {
  item: SidebarCatalogItem
  label: string
  actions: RowAction[]
  muted?: boolean
}) {
  return (
    <RowShell muted={muted} testId={`sidebar-customizer-row-${item.id}`}>
      <RowLabel item={item} label={label} />
      {actions.map((action) => (
        <IconAction key={action.key} action={action} itemId={item.id} />
      ))}
    </RowShell>
  )
}
