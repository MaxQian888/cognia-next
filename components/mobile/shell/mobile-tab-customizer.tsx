"use client"

/**
 * Bottom-tab customizer for the `/me` screen. Reorder tabs (dnd-kit), toggle
 * their visibility (guarded so ≥2 stay), and pick the launch landing tab. Opens
 * in a bottom `Sheet` from a `MeRow` so it sits naturally in the profile list.
 *
 * dnd-kit setup mirrors `components/shell/sidebar-customizer.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { GripVerticalIcon, LayoutGridIcon, RotateCcwIcon } from "lucide-react"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { MeRow } from "@/components/mobile/me/me-row"
import { cn } from "@/lib/utils"
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import { TAB_SPEC_BY_ID } from "./mobile-tab-bar"
import { useMobileTabLayout } from "./use-mobile-tab-layout"
import {
  DEFAULT_MOBILE_TAB_LAYOUT,
  MIN_VISIBLE_TABS,
  type MobileTabId,
} from "@/types/shell/mobile-tabs"

export function MobileTabCustomizer(): React.ReactElement {
  const t = useTranslations("mobile.tabBar.customize")
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <MeRow
        icon={LayoutGridIcon}
        label={t("title")}
        description={t("rowDescription")}
        onClick={() => setOpen(true)}
        testid="mobile-tab-customizer-row"
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-y-auto"
          data-testid="mobile-tab-customizer-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>{t("description")}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <MobileTabCustomizerBody />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

export function MobileTabCustomizerBody(): React.ReactElement {
  const t = useTranslations("mobile.tabBar.customize")
  const tTabs = useTranslations("mobile.tabs")
  const { resolved, reorder, hide, show, setDefaultLanding, reset } = useMobileTabLayout()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      resolved.order,
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) void reorder(next as MobileTabId[])
  }

  const isDefault =
    JSON.stringify({
      order: resolved.order,
      hidden: resolved.hidden,
      defaultLanding: resolved.defaultLanding,
    }) === JSON.stringify(DEFAULT_MOBILE_TAB_LAYOUT)

  const visibleSet = new Set(resolved.visible)
  const atFloor = resolved.visible.length <= MIN_VISIBLE_TABS

  return (
    <div className="space-y-4" data-testid="mobile-tab-customizer">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void reset()}
          disabled={isDefault}
          data-testid="mobile-tab-customizer-reset"
        >
          <RotateCcwIcon className="mr-1.5 size-3.5" />
          {t("restoreDefaults")}
        </Button>
      </div>

      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("tabs")}
          </h3>
          <span className="text-[11px] text-muted-foreground">{t("dragHint")}</span>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={resolved.order} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {resolved.order.map((id) => {
                const spec = TAB_SPEC_BY_ID[id]
                const visible = visibleSet.has(id)
                return (
                  <TabRow
                    key={id}
                    id={id}
                    Icon={spec?.icon}
                    label={tTabs(id)}
                    visible={visible}
                    // Can't hide the last tab above the floor.
                    disableToggle={visible && atFloor}
                    onToggle={(next) => void (next ? show(id) : hide(id))}
                  />
                )
              })}
            </ul>
          </SortableContext>
        </DndContext>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("landing")}
        </h3>
        <div className="flex flex-wrap gap-2">
          {resolved.visible.map((id) => {
            const active = resolved.defaultLanding === id
            return (
              <Button
                key={id}
                type="button"
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => void setDefaultLanding(id)}
                aria-pressed={active}
                data-testid={`mobile-tab-customizer-landing-${id}`}
              >
                {tTabs(id)}
              </Button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function TabRow({
  id,
  Icon,
  label,
  visible,
  disableToggle,
  onToggle,
}: {
  id: MobileTabId
  Icon?: React.ComponentType<{ className?: string }>
  label: string
  visible: boolean
  disableToggle: boolean
  onToggle: (next: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`mobile-tab-customizer-row-${id}`}
      className={cn(
        "flex items-center gap-2 rounded border bg-card px-2 py-1.5",
        !visible && "opacity-70",
        isDragging && "opacity-50 shadow-md"
      )}
    >
      <button
        type="button"
        className="flex size-7 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label={`drag ${label}`}
        data-testid={`mobile-tab-customizer-handle-${id}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      <span className="flex-1 truncate text-sm">{label}</span>
      <Switch
        checked={visible}
        disabled={disableToggle}
        onCheckedChange={onToggle}
        aria-label={label}
        data-testid={`mobile-tab-customizer-toggle-${id}`}
      />
    </li>
  )
}
