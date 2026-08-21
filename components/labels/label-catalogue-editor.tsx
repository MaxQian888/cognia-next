"use client"

/**
 * Manage one scope's label catalogue: create, rename, recolour, reorder,
 * delete.
 *
 * Generalised out of `components/settings/connections/tabs/labels-tab.tsx`,
 * which was bound to `scope: "conversation"` at every call. The issue tracker
 * seeds five labels at boot and had no way to reach any of them: no create, no
 * rename, no recolour, and `deleteLabel` refuses a built-in — so the catalogue
 * was effectively frozen at whatever `seedBuiltinIssueLabels` wrote.
 *
 * Two things stay the caller's:
 *  - `scope`, because a conversation label and an issue label are different
 *    catalogues that happen to share a table.
 *  - the strings, so this stays free of any one namespace.
 *
 * `colorMode` exists because the two scopes genuinely differ. Conversation
 * labels store free hex from a native colour input. Issue labels store oklch
 * theme tokens — feeding one of those to `<input type="color">` would silently
 * rewrite it as hex and lose the theme.
 */

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
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createLabel, deleteLabel, reorderLabels, updateLabel } from "@/lib/db/labels"
import { cn } from "@/lib/utils"
import { LABEL_COLORS, defaultLabelColor, type LabelRow, type LabelScope } from "@/types/labels"

/** Fallback for the hex input; the palette mode seeds from the name instead. */
const DEFAULT_HEX = "#64748b"

export interface LabelCatalogueStrings {
  title: string
  description: string
  nameLabel: string
  namePlaceholder: string
  colorLabel: string
  addButton: string
  nameRequired: string
  empty: string
  builtinBadge: string
  rowNameAria: (name: string) => string
  rowColorAria: (name: string) => string
  /** One swatch, by palette index — the raw oklch token is not a label. */
  swatchAria: (index: number) => string
  deleteAria: (name: string) => string
  reorderAria: (name: string) => string
}

export interface LabelCatalogueEditorProps {
  scope: LabelScope
  labels: readonly LabelRow[]
  strings: LabelCatalogueStrings
  /** `hex` gives a native colour input; `palette` gives the theme swatches. */
  colorMode?: "hex" | "palette"
  testId?: string
}

export function LabelCatalogueEditor({
  scope,
  labels,
  strings,
  colorMode = "hex",
  testId = "label-catalogue",
}: LabelCatalogueEditorProps) {
  const [name, setName] = useState("")
  const [color, setColor] = useState(DEFAULT_HEX)
  const [busy, setBusy] = useState(false)

  const sensors = useSensors(
    // A distance constraint so a click on the grip does not start a drag that
    // the user never meant.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleCreate() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(strings.nameRequired)
      return
    }
    setBusy(true)
    try {
      await createLabel({
        scope,
        name: trimmed,
        // In palette mode the swatch is picked per label afterwards; seeding
        // from the name keeps a new label distinguishable immediately.
        color: colorMode === "hex" ? color : defaultLabelColor(trimmed),
      })
      setName("")
      setColor(DEFAULT_HEX)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteLabel(id)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    if (!overId || activeId === overId) return
    const ids = labels.map((label) => label.id)
    const from = ids.indexOf(activeId)
    const to = ids.indexOf(overId)
    if (from === -1 || to === -1) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    try {
      await reorderLabels(scope, next)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-1">
        <Label className="text-sm font-medium">{strings.title}</Label>
        <p className="text-xs text-muted-foreground">{strings.description}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${testId}-new-name`} className="text-xs">
            {strings.nameLabel}
          </Label>
          <Input
            id={`${testId}-new-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={strings.namePlaceholder}
            disabled={busy}
            className="w-48"
            data-testid={`${testId}-new-name`}
          />
        </div>
        {colorMode === "hex" ? (
          <div className="space-y-1">
            <Label htmlFor={`${testId}-new-color`} className="text-xs">
              {strings.colorLabel}
            </Label>
            <Input
              id={`${testId}-new-color`}
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              disabled={busy}
              className="h-9 w-14 p-1"
              data-testid={`${testId}-new-color`}
            />
          </div>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={() => void handleCreate()}
          disabled={busy}
          data-testid={`${testId}-add`}
        >
          <PlusIcon className="size-3.5" />
          {strings.addButton}
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <ul className="divide-y rounded-md border" data-testid={`${testId}-list`}>
          {labels.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">{strings.empty}</li>
          ) : null}
          <SortableContext
            items={labels.map((label) => label.id)}
            strategy={verticalListSortingStrategy}
          >
            {labels.map((label) => (
              <LabelRowEditor
                key={label.id}
                label={label}
                strings={strings}
                colorMode={colorMode}
                testId={testId}
                onDelete={() => void handleDelete(label.id)}
              />
            ))}
          </SortableContext>
        </ul>
      </DndContext>
    </div>
  )
}

function LabelRowEditor({
  label,
  strings,
  colorMode,
  testId,
  onDelete,
}: {
  label: LabelRow
  strings: LabelCatalogueStrings
  colorMode: "hex" | "palette"
  testId: string
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: label.id,
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`${testId}-row-${label.id}`}
      className={cn("flex items-center gap-2 bg-background px-3 py-2", isDragging && "opacity-60")}
    >
      {/*
        The grip alone is the drag handle: the row holds a text input, and
        making the whole row draggable would swallow the click that focuses it.
      */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={strings.reorderAria(label.name)}
        data-testid={`${testId}-grip-${label.id}`}
        className="focus-visible:ring-ring/50 cursor-grab touch-none rounded-sm text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-[3px]"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>

      {colorMode === "hex" ? (
        <Input
          type="color"
          defaultValue={label.color ?? DEFAULT_HEX}
          aria-label={strings.rowColorAria(label.name)}
          onChange={(event) => {
            void updateLabel(label.id, { color: event.target.value })
          }}
          className="h-6 w-8 shrink-0 cursor-pointer rounded border p-0.5"
        />
      ) : (
        <PaletteSwatches
          value={label.color ?? defaultLabelColor(label.name)}
          ariaLabel={strings.rowColorAria(label.name)}
          swatchAria={strings.swatchAria}
          testId={`${testId}-color-${label.id}`}
          onChange={(next) => void updateLabel(label.id, { color: next })}
        />
      )}

      <Input
        defaultValue={label.name}
        aria-label={strings.rowNameAria(label.name)}
        onBlur={(event) => {
          const next = event.target.value.trim()
          if (next && next !== label.name) void updateLabel(label.id, { name: next })
        }}
        className="flex-1 truncate rounded bg-transparent px-1 text-sm outline-none focus:bg-muted"
        data-testid={`${testId}-name-${label.id}`}
      />

      {label.builtin ? (
        <Badge variant="outline" className="text-[10px]">
          {strings.builtinBadge}
        </Badge>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onDelete}
          aria-label={strings.deleteAria(label.name)}
          className="size-7"
          data-testid={`${testId}-delete-${label.id}`}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      )}
    </li>
  )
}

/** The eight theme tokens, as a radio group of swatches. */
function PaletteSwatches({
  value,
  ariaLabel,
  swatchAria,
  testId,
  onChange,
}: {
  value: string
  ariaLabel: string
  swatchAria: (index: number) => string
  testId: string
  onChange: (color: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex shrink-0 gap-0.5">
      {LABEL_COLORS.map((color, index) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={swatchAria(index)}
          onClick={() => onChange(color)}
          data-testid={`${testId}-${index}`}
          className={cn(
            "focus-visible:ring-ring/50 size-4 rounded-full focus-visible:outline-none focus-visible:ring-[3px]",
            color === value && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  )
}
