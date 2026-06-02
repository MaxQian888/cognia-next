"use client"

/**
 * The body of an Input/Output NDV tab for one data value. Hosts the Table /
 * JSON / Schema view toggle, an array item navigator, an empty state with an
 * optional "Run this step" CTA, and (for the Output tab) pin / unpin controls.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChevronLeftIcon, ChevronRightIcon, PinIcon, PinOffIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { toItems } from "@/lib/workflow/editor/node-io-data"
import type { PathSegment } from "@/lib/workflow/editor/expr-ref"
import type { NodeIoSource } from "@/types/workflow/visual"
import { DataTableView } from "./data-table-view"
import { DataJsonView } from "./data-json-view"
import { DataSchemaView } from "./data-schema-view"

type ViewMode = "table" | "json" | "schema"

export interface DataPanelPinControls {
  pinned: boolean
  onPin: (value: unknown) => void
  onUnpin: () => void
}

export function DataPanel({
  sourceNodeId,
  value,
  source,
  pin,
  onRunStep,
}: {
  sourceNodeId: string
  value: unknown
  source: NodeIoSource
  /** Output tab only — enables the pin / unpin / edit-fixture controls. */
  pin?: DataPanelPinControls
  /** Empty-state CTA — runs just this node. */
  onRunStep?: () => void
}) {
  const t = useTranslations("workflows.dataView")
  const [view, setView] = useState<ViewMode>("table")
  const [index, setIndex] = useState(0)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState("")

  const items = useMemo(() => toItems(value), [value])
  const isArray = Array.isArray(value)
  const clamped = items.length === 0 ? 0 : Math.min(index, items.length - 1)
  const currentItem = items[clamped]
  const basePrefix: PathSegment[] = isArray ? [clamped] : []

  if (source === "none") {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-8 text-center"
        data-testid="data-panel-empty"
      >
        <p className="text-sm font-medium">{t("emptyTitle")}</p>
        <p className="max-w-[220px] text-xs text-muted-foreground">{t("emptyHint")}</p>
        {onRunStep ? (
          <Button size="sm" variant="outline" className="mt-1" onClick={onRunStep}>
            <PlayIcon className="size-3.5 mr-1.5" />
            {t("runStepCta")}
          </Button>
        ) : null}
      </div>
    )
  }

  const startEditing = () => {
    setEditText(safeStringifyForEdit(pin?.pinned ? value : value))
    setEditing(true)
  }

  const saveEdited = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(editText)
    } catch {
      toast.error(t("pinParseError"))
      return
    }
    pin?.onPin(parsed)
    setEditing(false)
  }

  return (
    <div className="space-y-2" data-testid="data-panel">
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={view}
          onValueChange={(v) => v && setView(v as ViewMode)}
          aria-label={t("viewToggleAria")}
        >
          <ToggleGroupItem value="table" className="h-7 px-2 text-[11px]">
            {t("viewTable")}
          </ToggleGroupItem>
          <ToggleGroupItem value="json" className="h-7 px-2 text-[11px]">
            {t("viewJson")}
          </ToggleGroupItem>
          <ToggleGroupItem value="schema" className="h-7 px-2 text-[11px]">
            {t("viewSchema")}
          </ToggleGroupItem>
        </ToggleGroup>
        {source === "pin" ? (
          <Badge variant="outline" className="ml-auto gap-1 text-[10px]" data-testid="pinned-badge">
            <PinIcon className="size-3" aria-hidden="true" />
            {t("pinnedBadge")}
          </Badge>
        ) : null}
      </div>

      {items.length > 1 ? (
        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-2 py-1 text-[11px]">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={clamped <= 0}
            aria-label={t("prevItem")}
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="text-muted-foreground" data-testid="item-nav-label">
            {t("itemNav", { current: clamped + 1, total: items.length })}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
            disabled={clamped >= items.length - 1}
            aria-label={t("nextItem")}
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={8}
            className="font-mono text-xs"
            aria-label={t("editPinned")}
          />
          <p className="text-[11px] text-muted-foreground">{t("editPinnedHint")}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveEdited}>
              {t("savePinned")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("cancelEdit")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {view === "table" ? (
            <DataTableView sourceNodeId={sourceNodeId} item={currentItem} basePrefix={basePrefix} />
          ) : null}
          {view === "json" ? <DataJsonView item={currentItem} /> : null}
          {view === "schema" ? (
            <DataSchemaView
              sourceNodeId={sourceNodeId}
              item={currentItem}
              basePrefix={basePrefix}
            />
          ) : null}
        </>
      )}

      {pin && !editing ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {pin.pinned ? (
            <Button size="sm" variant="outline" onClick={pin.onUnpin}>
              <PinOffIcon className="size-3.5 mr-1.5" />
              {t("unpin")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => pin.onPin(value)}>
              <PinIcon className="size-3.5 mr-1.5" />
              {t("pin")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={startEditing}>
            {t("editPinned")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function safeStringifyForEdit(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return "null"
  }
}
