"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { BrainIcon, Trash2Icon, ExternalLinkIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig, type MemoryConfig, type MemoryScope } from "@/types/memory/memory"
import { clearMemories } from "@/lib/db/memories"
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
              <Label htmlFor="mem-auto">{t("autoExtract.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("autoExtract.description")}</p>
            </div>
            <Switch
              id="mem-auto"
              aria-label={t("autoExtract.label")}
              checked={config.autoExtract}
              disabled={!config.enabled}
              onCheckedChange={(v) => update({ autoExtract: v })}
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

          <div className="grid gap-3 sm:grid-cols-2">
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
          await clearMemories()
        }}
      />
    </SettingsCard>
  )
}
