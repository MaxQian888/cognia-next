"use client"

import React, { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  collectComponentSubtreeIds,
  getComponentCollectionSlots,
  type A2UIComponentPlacement,
} from "@/lib/a2ui/component-tree"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { cn } from "@/lib/utils"

interface PlacementOption extends A2UIComponentPlacement {
  key: string
  childIds: string[]
  parentType: string
}

export interface ComponentPlacementDialogProps {
  mode: "add" | "move"
  components: Record<string, A2UIComponent>
  componentTypes: string[]
  componentId?: string
  onOpenChange: (open: boolean) => void
  onAdd: (type: string, placement: A2UIComponentPlacement) => boolean
  onAddToRoot: (type: string) => boolean
  onMove: (placement: A2UIComponentPlacement) => boolean
}

const SURFACE_ROOT_OPTION = "__surface_root__"

function createPlacementOptions(
  components: Record<string, A2UIComponent>,
  movingComponentId?: string
): PlacementOption[] {
  const movingSubtree = movingComponentId
    ? collectComponentSubtreeIds(components, movingComponentId)
    : new Set<string>()

  return Object.entries(components).flatMap(([parentId, component]) => {
    if (movingSubtree.has(parentId)) return []
    return getComponentCollectionSlots(component).map((slot) => ({
      key: `${parentId}:${slot.id}`,
      parentId,
      parentType: component.component,
      slotId: slot.id,
      childIds: slot.childIds,
    }))
  })
}

function slotLabel(slotId: string, t: ReturnType<typeof useTranslations>): string {
  if (slotId === "/children") return t("slotChildren")
  if (slotId === "/footer") return t("slotFooter")
  if (slotId === "/actions") return t("slotActions")
  const match = slotId.match(/^\/(tabs|items|steps)\/(\d+)\/(children|content)$/)
  if (!match) return slotId
  const index = Number(match[2]) + 1
  if (match[1] === "tabs") return t("slotTab", { index })
  if (match[1] === "items") return t("slotAccordionItem", { index })
  return t("slotGuideStep", { index })
}

export function ComponentPlacementDialog({
  mode,
  components,
  componentTypes,
  componentId,
  onOpenChange,
  onAdd,
  onAddToRoot,
  onMove,
}: ComponentPlacementDialogProps) {
  const t = useTranslations("a2ui")
  const placements = useMemo(
    () => createPlacementOptions(components, mode === "move" ? componentId : undefined),
    [componentId, components, mode]
  )
  const initialPlacement = useMemo(() => {
    if (mode !== "move" || !componentId) return placements[0]
    return placements.find((placement) => placement.childIds.includes(componentId)) ?? placements[0]
  }, [componentId, mode, placements])
  const [selectedType, setSelectedType] = useState(componentTypes[0] ?? "")
  const [query, setQuery] = useState("")
  const [placementKey, setPlacementKey] = useState(
    initialPlacement?.key ?? (mode === "add" ? SURFACE_ROOT_OPTION : "")
  )
  const initialIndex = initialPlacement
    ? mode === "move" && componentId
      ? Math.max(initialPlacement.childIds.indexOf(componentId), 0)
      : initialPlacement.childIds.length
    : 0
  const [position, setPosition] = useState(initialIndex)
  const [submitFailed, setSubmitFailed] = useState(false)

  const selectedPlacement =
    placements.find((placement) => placement.key === placementKey) ?? placements[0]
  const usesSurfaceRoot = mode === "add" && placementKey === SURFACE_ROOT_OPTION
  const filteredTypes = componentTypes.filter((type) =>
    type.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const maxPosition = selectedPlacement
    ? Math.max(
        0,
        selectedPlacement.childIds.length -
          (mode === "move" && componentId && selectedPlacement.childIds.includes(componentId)
            ? 1
            : 0)
      )
    : 0

  const handlePlacementChange = (key: string) => {
    setPlacementKey(key)
    if (key === SURFACE_ROOT_OPTION) {
      setPosition(1)
      setSubmitFailed(false)
      return
    }
    const placement = placements.find((option) => option.key === key)
    setPosition(
      placement
        ? mode === "move" && componentId && placement.childIds.includes(componentId)
          ? Math.max(placement.childIds.indexOf(componentId), 0)
          : placement.childIds.length
        : 0
    )
    setSubmitFailed(false)
  }

  const handleSubmit = () => {
    if (mode === "add" && usesSurfaceRoot) {
      const succeeded = Boolean(selectedType && onAddToRoot(selectedType))
      if (succeeded) onOpenChange(false)
      else setSubmitFailed(true)
      return
    }
    if (!selectedPlacement) return
    const placement = {
      parentId: selectedPlacement.parentId,
      slotId: selectedPlacement.slotId,
      index: Math.max(0, Math.min(position, maxPosition)),
    }
    const succeeded =
      mode === "add" ? Boolean(selectedType && onAdd(selectedType, placement)) : onMove(placement)
    if (succeeded) onOpenChange(false)
    else setSubmitFailed(true)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(mode === "add" ? "addComponent" : "moveComponent")}</DialogTitle>
          <DialogDescription>
            {t(mode === "add" ? "addComponentDescription" : "moveComponentDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === "add" && (
            <div className="space-y-2">
              <Label htmlFor="component-type-search">{t("componentType")}</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="component-type-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchComponents")}
                  className="pl-8"
                />
              </div>
              <ScrollArea className="h-40 rounded-md border p-1">
                <div className="grid grid-cols-2 gap-1">
                  {filteredTypes.map((type) => (
                    <Button
                      key={type}
                      type="button"
                      variant={selectedType === type ? "secondary" : "ghost"}
                      size="sm"
                      className={cn("justify-start font-mono", selectedType === type && "border")}
                      onClick={() => {
                        setSelectedType(type)
                        setSubmitFailed(false)
                      }}
                    >
                      {type}
                    </Button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="component-destination">{t("destination")}</Label>
            <Select value={placementKey} onValueChange={handlePlacementChange}>
              <SelectTrigger id="component-destination">
                <SelectValue placeholder={t("selectDestination")} />
              </SelectTrigger>
              <SelectContent>
                {mode === "add" && (
                  <SelectItem value={SURFACE_ROOT_OPTION}>{t("surfaceRoot")}</SelectItem>
                )}
                {placements.map((placement) => (
                  <SelectItem key={placement.key} value={placement.key}>
                    {placement.parentType} · {placement.parentId} · {slotLabel(placement.slotId, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!usesSurfaceRoot && (
            <div className="space-y-2">
              <Label htmlFor="component-position">{t("position")}</Label>
              <Input
                id="component-position"
                type="number"
                min={0}
                max={maxPosition}
                value={position}
                onChange={(event) => {
                  setPosition(Number(event.target.value))
                  setSubmitFailed(false)
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t("positionHelp", { max: maxPosition })}
              </p>
            </div>
          )}

          {submitFailed && (
            <p role="alert" className="text-sm text-destructive">
              {t("componentMutationFailed")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={(!selectedPlacement && !usesSurfaceRoot) || (mode === "add" && !selectedType)}
            onClick={handleSubmit}
          >
            {t(mode === "add" ? "add" : "move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
