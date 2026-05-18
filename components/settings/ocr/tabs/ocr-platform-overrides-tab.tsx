"use client"

/**
 * OCR Platform Overrides tab — per-OS reorderable local-engine preference.
 *
 * The auto-router in `lib/ocr/auto-router.ts` picks a local engine by walking
 * a per-OS preference list (`DEFAULT_LOCAL_PREFERENCE`). This tab lets the
 * user override that list per OS — drag to reorder, optionally remove an
 * engine. The reset button per OS bucket reverts only that bucket.
 *
 * dnd-kit setup mirrors `prompt-presets-section.tsx`.
 */

import * as React from "react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GripVerticalIcon, RotateCcw, X } from "lucide-react"
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
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DEFAULT_LOCAL_PREFERENCE } from "@/lib/ocr/auto-router"
import type { OcrPlatformOverrideKey, UserOcrSettings } from "@/lib/ocr/types"
import { cn } from "@/lib/utils"

interface OcrPlatformOverridesTabProps {
  settings: UserOcrSettings
  onChange: (next: UserOcrSettings) => void
}

const OS_KEYS: readonly OcrPlatformOverrideKey[] = [
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "browser",
]

function effectiveOrder(settings: UserOcrSettings, os: OcrPlatformOverrideKey): readonly string[] {
  const override = settings.platformOverrides?.[os]
  if (override && override.length > 0) return override
  return DEFAULT_LOCAL_PREFERENCE[os] ?? []
}

export function OcrPlatformOverridesTab({
  settings,
  onChange,
}: OcrPlatformOverridesTabProps): React.ReactElement {
  const t = useTranslations()
  const [activeOs, setActiveOs] = useState<OcrPlatformOverrideKey>("windows")

  return (
    <Card data-testid="ocr-platform-overrides-tab">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("ocr.platformOverrides.title")}</CardTitle>
        <CardDescription className="text-xs">
          {t("ocr.platformOverrides.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeOs} onValueChange={(v) => setActiveOs(v as OcrPlatformOverrideKey)}>
          <TabsList className="flex w-full flex-wrap">
            {OS_KEYS.map((os) => (
              <TabsTrigger key={os} value={os} data-testid={`ocr-os-tab-${os}`}>
                {t(`ocr.platformOverrides.oses.${os}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {OS_KEYS.map((os) => (
            <TabsContent key={os} value={os} className="mt-4">
              <OsBucketEditor os={os} settings={settings} onChange={onChange} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}

interface OsBucketEditorProps {
  os: OcrPlatformOverrideKey
  settings: UserOcrSettings
  onChange: (next: UserOcrSettings) => void
}

function OsBucketEditor({ os, settings, onChange }: OsBucketEditorProps) {
  const t = useTranslations()
  const order = useMemo(() => effectiveOrder(settings, os), [settings, os])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const writeOrder = (next: readonly string[]) => {
    const defaults = DEFAULT_LOCAL_PREFERENCE[os] ?? []
    const isDefault =
      next.length === defaults.length && next.every((id, idx) => id === defaults[idx])
    const overrides = { ...(settings.platformOverrides ?? {}) }
    if (isDefault) {
      delete overrides[os]
    } else {
      overrides[os] = [...next]
    }
    onChange({ ...settings, platformOverrides: overrides })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(String(active.id))
    const newIndex = order.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    writeOrder(arrayMove([...order], oldIndex, newIndex))
  }

  const handleRemove = (engineId: string) => {
    writeOrder(order.filter((id) => id !== engineId))
  }

  const handleReset = () => {
    const overrides = { ...(settings.platformOverrides ?? {}) }
    delete overrides[os]
    onChange({ ...settings, platformOverrides: overrides })
  }

  const hasOverride = Boolean(settings.platformOverrides?.[os])

  return (
    <div className="space-y-3" data-testid={`ocr-os-bucket-${os}`}>
      <p className="text-xs text-muted-foreground">{t("ocr.platformOverrides.dragHint")}</p>
      {order.length === 0 ? (
        <p className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground">
          {t("ocr.platformOverrides.emptyBucket")}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
            <ol className="space-y-1">
              {order.map((engineId, idx) => (
                <SortableEngineRow
                  key={engineId}
                  engineId={engineId}
                  rank={idx + 1}
                  onRemove={handleRemove}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {hasOverride
            ? t("ocr.platformOverrides.usingOverride")
            : t("ocr.platformOverrides.usingDefault")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleReset}
          disabled={!hasOverride}
          data-testid={`ocr-os-reset-${os}`}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("ocr.platformOverrides.resetToDefaults")}
        </Button>
      </div>
    </div>
  )
}

function SortableEngineRow({
  engineId,
  rank,
  onRemove,
}: {
  engineId: string
  rank: number
  onRemove: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: engineId,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded border bg-card px-2 py-1.5",
        isDragging && "opacity-50 shadow-md"
      )}
      data-testid={`ocr-engine-row-${engineId}`}
    >
      <button
        type="button"
        className="flex h-6 w-6 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label="drag"
        data-testid={`ocr-engine-handle-${engineId}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="h-4 w-4" />
      </button>
      <span className="text-xs font-mono text-muted-foreground">{rank}.</span>
      <span className="flex-1 text-sm">{engineId}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={() => onRemove(engineId)}
        aria-label="remove"
        data-testid={`ocr-engine-remove-${engineId}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}
