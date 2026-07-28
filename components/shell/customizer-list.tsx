"use client"

/**
 * Shared layout editor used by every catalog-style customizer in the app: the
 * desktop nav rail (`sidebar-customizer.tsx`), the discover categories
 * (`components/discover/discover-customizer.tsx`) and the two window bars
 * (`bar-customizer.tsx`).
 *
 * They used to be the same ~350 lines of dnd-kit plumbing duplicated; this
 * module owns it once. Callers pass their resolved buckets (as generic
 * `{ id, Icon, label }` items), the mutation handlers, and a `testIdPrefix` so
 * existing test ids stay stable per surface.
 *
 * ## Three buckets or two
 *
 * Surfaces with an overflow home (the rail's "More" popover, the discover
 * overflow row) pass `overflow` and get the three-bucket editor. A window bar
 * has no third home — a segment is in the bar or it is not — so it omits
 * `overflow`, and the More section plus the per-row "move to More" action drop
 * out. `onPin` is optional for the same reason: with two buckets, unhiding is
 * the only way back in.
 *
 * dnd-kit setup mirrors `components/settings/ocr/tabs/ocr-platform-overrides-tab.tsx`.
 */

import * as React from "react"
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
import { applyDragReorder } from "@/lib/shell/sidebar-nav"
import { cn } from "@/lib/utils"

/** A generic customizable item — icon + label keyed by a stable id. */
export interface CustomizerItem {
  id: string
  Icon: React.ComponentType<{ className?: string }>
  label: string
  /**
   * Optional trailing annotation, rendered as a muted badge after the label.
   * The bar customizers use it for the item's zone ("Left" / "Centre" /
   * "Right"), which is what makes a drag that crosses a zone boundary
   * understandable rather than mysterious.
   */
  hint?: string
}

/** Localized strings every editor needs, from the caller's i18n namespace. */
export interface CustomizerLabels {
  restoreDefaults: string
  pinned: string
  dragHint: string
  pinnedEmpty: string
  hidden: string
  hiddenEmpty: string
  hideItem: string
  showItem: string
}

/** The extra strings the three-bucket editor's "More" section needs. */
export interface CustomizerOverflowLabels extends CustomizerLabels {
  more: string
  moreEmpty: string
  moveToMore: string
  pin: string
}

interface CustomizerListsBaseProps {
  pinned: CustomizerItem[]
  hidden: CustomizerItem[]
  isDefault: boolean
  /** Prefix for every `data-testid` so each surface keeps stable ids. */
  testIdPrefix: string
  onReorderPinned: (ids: string[]) => void
  onHide: (id: string) => void
  onShow: (id: string) => void
  onReset: () => void
}

/**
 * Two shapes, so the impossible middles cannot be constructed: a three-bucket
 * editor must supply the overflow bucket, its two handlers AND its four extra
 * strings together, and a two-bucket editor supplies none of them.
 */
export type CustomizerListsProps = CustomizerListsBaseProps &
  (
    | {
        /** Three buckets — the surface has a "More" home. */
        overflow: CustomizerItem[]
        labels: CustomizerOverflowLabels
        onPin: (id: string) => void
        onUnpin: (id: string) => void
      }
    | {
        /** Two buckets — an item is in the surface or it is not. */
        overflow?: never
        labels: CustomizerLabels
        onPin?: never
        onUnpin?: never
      }
  )

export function CustomizerLists(props: CustomizerListsProps): React.ReactElement {
  const {
    pinned,
    hidden,
    isDefault,
    labels,
    testIdPrefix,
    onReorderPinned,
    onHide,
    onShow,
    onReset,
  } = props
  // One narrowing for the whole render: either the caller opted into the
  // three-bucket editor (bucket + handlers + strings, all present together) or
  // it did not. Re-checking `props.overflow` at each use site would force TS to
  // re-narrow `labels` too.
  const withOverflow = props.overflow ? props : null

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const next = applyDragReorder(
      pinned.map((i) => i.id),
      String(event.active.id),
      event.over ? String(event.over.id) : null
    )
    if (next) onReorderPinned(next)
  }

  return (
    <div className="space-y-4" data-testid={testIdPrefix}>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={isDefault}
          data-testid={`${testIdPrefix}-reset`}
        >
          <RotateCcwIcon className="mr-1.5 h-3.5 w-3.5" />
          {labels.restoreDefaults}
        </Button>
      </div>

      <ListSection title={labels.pinned} hint={labels.dragHint}>
        {pinned.length === 0 ? (
          <EmptyRow label={labels.pinnedEmpty} />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={pinned.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-1">
                {pinned.map((item) => (
                  <PinnedRow
                    key={item.id}
                    item={item}
                    testIdPrefix={testIdPrefix}
                    hideLabel={labels.hideItem}
                    moveToMore={
                      withOverflow
                        ? {
                            label: withOverflow.labels.moveToMore,
                            onClick: () => withOverflow.onUnpin(item.id),
                          }
                        : undefined
                    }
                    onHide={() => onHide(item.id)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </ListSection>

      {withOverflow ? (
        <ListSection title={withOverflow.labels.more}>
          {withOverflow.overflow.length === 0 ? (
            <EmptyRow label={withOverflow.labels.moreEmpty} />
          ) : (
            <ul className="space-y-1">
              {withOverflow.overflow.map((item) => (
                <StaticRow
                  key={item.id}
                  item={item}
                  testIdPrefix={testIdPrefix}
                  actions={[
                    {
                      key: "pin",
                      label: withOverflow.labels.pin,
                      Icon: PinIcon,
                      onClick: () => withOverflow.onPin(item.id),
                    },
                    {
                      key: "hide",
                      label: labels.hideItem,
                      Icon: EyeOffIcon,
                      onClick: () => onHide(item.id),
                    },
                  ]}
                />
              ))}
            </ul>
          )}
        </ListSection>
      ) : null}

      <ListSection title={labels.hidden}>
        {hidden.length === 0 ? (
          <EmptyRow label={labels.hiddenEmpty} />
        ) : (
          <ul className="space-y-1">
            {hidden.map((item) => (
              <StaticRow
                key={item.id}
                item={item}
                muted
                testIdPrefix={testIdPrefix}
                actions={[
                  {
                    key: "show",
                    label: labels.showItem,
                    Icon: EyeIcon,
                    onClick: () => onShow(item.id),
                  },
                  ...(withOverflow
                    ? [
                        {
                          key: "pin",
                          label: withOverflow.labels.pin,
                          Icon: PinIcon,
                          onClick: () => withOverflow.onPin(item.id),
                        },
                      ]
                    : []),
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

function IconAction({
  action,
  itemId,
  testIdPrefix,
}: {
  action: RowAction
  itemId: string
  testIdPrefix: string
}) {
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
          data-testid={`${testIdPrefix}-${action.key}-${itemId}`}
        >
          <action.Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  )
}

function RowLabel({ item }: { item: CustomizerItem }) {
  return (
    <>
      <item.Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{item.label}</span>
      {item.hint ? (
        <span
          className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid={`customizer-hint-${item.id}`}
        >
          {item.hint}
        </span>
      ) : null}
    </>
  )
}

function PinnedRow({
  item,
  testIdPrefix,
  hideLabel,
  moveToMore,
  onHide,
}: {
  item: CustomizerItem
  testIdPrefix: string
  hideLabel: string
  /** Present only in the three-bucket editor — label and handler travel together. */
  moveToMore?: { label: string; onClick: () => void }
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
      testId={`${testIdPrefix}-pinned-${item.id}`}
    >
      <button
        type="button"
        className="flex size-6 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label={`drag ${item.label}`}
        data-testid={`${testIdPrefix}-handle-${item.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <RowLabel item={item} />
      {moveToMore ? (
        <IconAction
          action={{ key: "unpin", Icon: EllipsisIcon, ...moveToMore }}
          itemId={item.id}
          testIdPrefix={testIdPrefix}
        />
      ) : null}
      <IconAction
        action={{ key: "hide", label: hideLabel, Icon: EyeOffIcon, onClick: onHide }}
        itemId={item.id}
        testIdPrefix={testIdPrefix}
      />
    </RowShell>
  )
}

function StaticRow({
  item,
  actions,
  muted,
  testIdPrefix,
}: {
  item: CustomizerItem
  actions: RowAction[]
  muted?: boolean
  testIdPrefix: string
}) {
  return (
    <RowShell muted={muted} testId={`${testIdPrefix}-row-${item.id}`}>
      <RowLabel item={item} />
      {actions.map((action) => (
        <IconAction key={action.key} action={action} itemId={item.id} testIdPrefix={testIdPrefix} />
      ))}
    </RowShell>
  )
}
