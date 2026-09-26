"use client"

/**
 * Drag-to-reorder for the navigation's own lists — the rail's pinned
 * features, workspace modes and teams, and the same lists as rows in the
 * expanded sidebar (`sidebar-nav-section.tsx`).
 *
 * Deliberately thinner than the customizer's dnd plumbing
 * (`customizer-list.tsx`): these items are live navigation, so the whole
 * control is the drag handle and a plain click must still navigate. The
 * pointer sensor only arms after 4px of travel, which is what keeps a click a
 * click. There is no keyboard sensor — arrow keys already move focus between
 * the rows (`sidebar-row-roving.tsx`), and an item cannot both move focus and
 * pick itself up on the same key. The keyboard path for a reorder is the
 * items' "Move up / Move down" context-menu entries instead.
 *
 * dnd-kit reads its announcements aloud, so they come from the message
 * catalog (`desktop.navReorder.*`) like any other user-facing string; the
 * customizer shares the same set (`useReorderAnnouncements`).
 */

import { useCallback, useMemo, type CSSProperties, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { applyDragReorder } from "@/lib/shell/sidebar-nav"

/**
 * Localized dnd-kit announcements for a list of `ids`, naming items through
 * `labelOf` and positions 1-based ("Picked up Inbox. Position 2 of 5.").
 *
 * `keyboard` picks the screen-reader instructions: a list with a keyboard
 * sensor (the customizer) explains Space / arrows / Escape; a pointer-only
 * list (the navigation itself) points at the "Move up / Move down" menu items.
 */
export function useReorderAnnouncements(
  ids: readonly string[],
  labelOf: (id: string) => string,
  { keyboard = false }: { keyboard?: boolean } = {}
): { announcements: Announcements; instructions: string } {
  const t = useTranslations("desktop.navReorder")
  return useMemo(() => {
    const total = ids.length
    const position = (id: unknown) => ids.indexOf(String(id)) + 1
    const name = (id: unknown) => labelOf(String(id))
    return {
      announcements: {
        onDragStart: ({ active }) =>
          t("pickedUp", { item: name(active.id), position: position(active.id), total }),
        onDragOver: ({ active, over }) =>
          over
            ? t("over", { item: name(active.id), position: position(over.id), total })
            : undefined,
        onDragEnd: ({ active, over }) =>
          over
            ? t("dropped", { item: name(active.id), position: position(over.id), total })
            : t("cancelled", { item: name(active.id) }),
        onDragCancel: ({ active }) => t("cancelled", { item: name(active.id) }),
      },
      instructions: keyboard ? t("instructionsKeyboard") : t("instructions"),
    }
  }, [ids, labelOf, t, keyboard])
}

export interface NavSortableListProps {
  /** The ids in render order — exactly the ones a drop may land on. */
  ids: readonly string[]
  /** The whole new order after a drop that moved something. */
  onReorder: (ids: string[]) => void
  /** Spoken name of an item, for the announcements. */
  labelOf: (id: string) => string
  children: ReactNode
}

export function NavSortableList({ ids, onReorder, labelOf, children }: NavSortableListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const { announcements, instructions } = useReorderAnnouncements(ids, labelOf)
  const items = useMemo(() => [...ids], [ids])
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const next = applyDragReorder(
        [...ids],
        String(event.active.id),
        event.over ? String(event.over.id) : null
      )
      if (next) onReorder(next)
    },
    [ids, onReorder]
  )
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: instructions } }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/** What a sortable item hands to the element that actually moves. */
export interface NavDragBinding {
  /**
   * Attach to the element that moves. Not called `ref`: this binding is
   * passed around as a prop, and a prop object with a `ref` field reads to
   * the React compiler's lint as a ref being dereferenced during render.
   */
  setNodeRef: (node: HTMLElement | null) => void
  style: CSSProperties
  dragging: boolean
  /** Pointer listeners plus the two announcement attributes, never a tab stop. */
  handleProps: Record<string, unknown>
}

/**
 * One draggable item. A component of its own because `useSortable` cannot be
 * called conditionally and only some items of a surface are sortable.
 */
export function NavSortableItem({
  id,
  children,
}: {
  id: string
  children: (binding: NavDragBinding) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  // `attributes` also carries `role="button"` and `tabIndex={0}` for a plain
  // div activator. Here the activator wraps a control that already is a
  // button and already sits in a roving tab order, so only the two
  // announcements are taken — the same trade `sidebar-guild-sections.tsx`
  // makes for its team rows.
  const handleProps: Record<string, unknown> = {
    ...listeners,
    "aria-roledescription": attributes["aria-roledescription"],
    "aria-describedby": attributes["aria-describedby"],
  }
  return (
    <>
      {children({
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        dragging: isDragging,
        handleProps,
      })}
    </>
  )
}
