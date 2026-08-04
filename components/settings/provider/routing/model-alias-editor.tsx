"use client"

// Dialog editor for a single model-alias mapping. Works on a local draft and
// persists through `useSettingsStore.upsertModelMapping` on save.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ModelAliasEntryRow } from "./model-alias-entry-row"
import type {
  MappingDistributionStrategy,
  ModelMapping,
} from "@cognia/provider-types/model-mapping"

interface ModelAliasEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Mapping to edit, or null to create a new one. */
  mapping: ModelMapping | null
}

function newDraft(): ModelMapping {
  const now = Date.now()
  return {
    id: `mapping-${now.toString(36)}`,
    alias: "",
    providers: [{ providerId: "", modelId: "" }],
    distribution: "priority",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

export function ModelAliasEditor({ open, onOpenChange, mapping }: ModelAliasEditorProps) {
  const t = useTranslations("providers.routingView")
  const upsertModelMapping = useSettingsStore((s) => s.upsertModelMapping)
  const [draft, setDraft] = useState<ModelMapping>(() => mapping ?? newDraft())

  // Re-seed the draft whenever the dialog (re)opens, possibly on a different
  // mapping. Adjust-state-during-render pattern (not an effect) so the reset
  // happens before paint without cascading renders.
  const [prevSeed, setPrevSeed] = useState<{ open: boolean; mapping: ModelMapping | null }>({
    open,
    mapping,
  })
  if (prevSeed.open !== open || prevSeed.mapping !== mapping) {
    setPrevSeed({ open, mapping })
    if (open) setDraft(mapping ?? newDraft())
  }

  const validEntries = draft.providers.filter((e) => e.providerId && e.modelId)
  const canSave = draft.alias.trim().length > 0 && validEntries.length > 0

  const handleSave = async () => {
    await upsertModelMapping({
      ...draft,
      alias: draft.alias.trim(),
      providers: validEntries,
    })
    onOpenChange(false)
  }

  const moveEntry = (index: number, direction: -1 | 1) => {
    setDraft((d) => {
      const next = [...d.providers]
      const target = index + direction
      if (target < 0 || target >= next.length) return d
      ;[next[index], next[target]] = [next[target], next[index]]
      return { ...d, providers: next }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mapping ? t("editAlias") : t("addAlias")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="alias-name">
                {t("aliasName")}
              </Label>
              <Input
                id="alias-name"
                value={draft.alias}
                placeholder={t("aliasNamePlaceholder")}
                onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value }))}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("distribution")}</Label>
              <Select
                value={draft.distribution}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, distribution: v as MappingDistributionStrategy }))
                }
              >
                <SelectTrigger className="h-8 text-xs" aria-label={t("distribution")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">{t("distributionPriority")}</SelectItem>
                  <SelectItem value="weighted">{t("distributionWeighted")}</SelectItem>
                  <SelectItem value="round-robin">{t("distributionRoundRobin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-xs" htmlFor="alias-enabled">
              {t("aliasEnabled")}
            </Label>
            <Switch
              id="alias-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t("entriesTitle")}</Label>
            <div className="space-y-1.5">
              {draft.providers.map((entry, i) => (
                <ModelAliasEntryRow
                  key={i}
                  entry={entry}
                  index={i}
                  total={draft.providers.length}
                  showWeight={draft.distribution === "weighted"}
                  onChange={(next) =>
                    setDraft((d) => ({
                      ...d,
                      providers: d.providers.map((e, j) => (j === i ? next : e)),
                    }))
                  }
                  onMove={(dir) => moveEntry(i, dir)}
                  onRemove={() =>
                    setDraft((d) => ({
                      ...d,
                      providers: d.providers.filter((_, j) => j !== i),
                    }))
                  }
                />
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  providers: [...d.providers, { providerId: "", modelId: "" }],
                }))
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              {t("addEntry")}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void handleSave()}>
            {t("saveAlias")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ModelAliasEditor
