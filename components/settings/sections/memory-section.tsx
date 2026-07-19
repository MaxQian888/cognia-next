"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { BrainIcon, Trash2Icon, ExternalLinkIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig, type MemoryConfig, type MemoryScope } from "@/types/memory/memory"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import { SettingsCard } from "../common/settings-section"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

/**
 * Settings → Memory: configure the autonomous long-term memory subsystem and
 * jump to the full `/memory` management panel. Mirrors the `ConversationSection`
 * structure (base `SettingsCard` + `useSettingsStore.save`).
 */
export function MemorySection() {
  const t = useTranslations("settings.memory")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [clearOpen, setClearOpen] = useState(false)

  const config = resolveMemoryConfig(settings?.memory)
  const update = (patch: Partial<MemoryConfig>) => void save({ memory: { ...config, ...patch } })

  const parseInt10 = (raw: string, fallback: number) => {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const parseFloatInRange = (raw: string, fallback: number, min: number, max: number) => {
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  }

  return (
    <SettingsCard
      icon={<BrainIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-8">
        {/* Master toggle */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-enabled">{t("enabled.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("enabled.description")}</p>
            </div>
            <Switch
              id="mem-enabled"
              aria-label={t("enabled.label")}
              checked={config.enabled}
              onCheckedChange={(v) => update({ enabled: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-use">{t("useMemory.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("useMemory.description")}</p>
            </div>
            <Switch
              id="mem-use"
              aria-label={t("useMemory.label")}
              checked={config.useMemory}
              disabled={!config.enabled}
              onCheckedChange={(v) => update({ useMemory: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-learn">{t("learnFromChats.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("learnFromChats.description")}</p>
            </div>
            <Switch
              id="mem-learn"
              aria-label={t("learnFromChats.label")}
              checked={config.learnFromChats}
              disabled={!config.enabled}
              onCheckedChange={(v) => update({ learnFromChats: v, autoExtract: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-external-context">{t("externalContext.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("externalContext.description")}</p>
            </div>
            <Switch
              id="mem-external-context"
              aria-label={t("externalContext.label")}
              checked={config.disableLearningOnExternalContext}
              disabled={!config.enabled || !config.learnFromChats}
              onCheckedChange={(v) => update({ disableLearningOnExternalContext: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-temporary">{t("temporary.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("temporary.description")}</p>
            </div>
            <Switch
              id="mem-temporary"
              aria-label={t("temporary.label")}
              checked={config.temporary}
              onCheckedChange={(v) => update({ temporary: v })}
            />
          </div>
        </section>

        {/* Scope + retrieval */}
        <section className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("scope.heading")}</Label>
            <p className="text-xs text-muted-foreground">{t("scope.description")}</p>
            <Select
              value={config.scopeDefault}
              onValueChange={(v) => update({ scopeDefault: v as MemoryScope })}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">{t("scope.global")}</SelectItem>
                <SelectItem value="workspace">{t("scope.workspace")}</SelectItem>
                <SelectItem value="character">{t("scope.character")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-hybrid">{t("hybrid.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("hybrid.description")}</p>
            </div>
            <Switch
              id="mem-hybrid"
              aria-label={t("hybrid.label")}
              checked={config.hybridEnabled}
              onCheckedChange={(v) => update({ hybridEnabled: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-query-expansion">{t("queryExpansion.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("queryExpansion.description")}</p>
            </div>
            <Switch
              id="mem-query-expansion"
              aria-label={t("queryExpansion.label")}
              checked={config.enableQueryExpansion ?? false}
              onCheckedChange={(v) => update({ enableQueryExpansion: v })}
              disabled={!config.enabled}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="mem-cloud">{t("cloudEmbedding.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("cloudEmbedding.description")}</p>
            </div>
            <Switch
              id="mem-cloud"
              aria-label={t("cloudEmbedding.label")}
              checked={config.allowCloudEmbedding}
              onCheckedChange={(v) => update({ allowCloudEmbedding: v })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="mem-topk">{t("topK.label")}</Label>
              <Input
                id="mem-topk"
                type="number"
                min={1}
                value={config.retrievalTopK}
                onChange={(e) => update({ retrievalTopK: parseInt10(e.target.value, 8) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-token-budget">{t("tokenBudget.label")}</Label>
              <Input
                id="mem-token-budget"
                type="number"
                min={64}
                value={config.recallTokenBudget}
                onChange={(e) => update({ recallTokenBudget: parseInt10(e.target.value, 900) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-relevance">{t("relevanceFloor.label")}</Label>
              <Input
                id="mem-relevance"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={config.relevanceFloor}
                onChange={(e) =>
                  update({
                    relevanceFloor: parseFloatInRange(e.target.value, 0.35, 0, 1),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-half-life">{t("halfLife.label")}</Label>
              <Input
                id="mem-half-life"
                type="number"
                min={1}
                value={config.decayHalfLifeDays}
                onChange={(e) => update({ decayHalfLifeDays: parseInt10(e.target.value, 30) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-max-idle">{t("maxIdle.label")}</Label>
              <Input
                id="mem-max-idle"
                type="number"
                min={0}
                value={config.maxIdleDays ?? 0}
                onChange={(e) =>
                  update({ maxIdleDays: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-cap">{t("cap.label")}</Label>
              <Input
                id="mem-cap"
                type="number"
                min={1}
                value={config.maxActivePerScope}
                onChange={(e) => update({ maxActivePerScope: parseInt10(e.target.value, 500) })}
              />
            </div>
          </div>
        </section>

        {/* Management */}
        <section className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline">
            <Link href="/memory">
              <ExternalLinkIcon className="size-4" />
              {t("manage")}
            </Link>
          </Button>
          <Button variant="destructive" onClick={() => setClearOpen(true)}>
            <Trash2Icon className="size-4" />
            {t("clearAll.button")}
          </Button>
        </section>
      </div>

      <ConfirmActionDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t("clearAll.title")}
        description={t("clearAll.description")}
        confirmLabel={t("clearAll.confirm")}
        cancelLabel={t("clearAll.cancel")}
        tone="destructive"
        onConfirm={async () => {
          await manageMemory({ kind: "clear" })
        }}
      />
    </SettingsCard>
  )
}
