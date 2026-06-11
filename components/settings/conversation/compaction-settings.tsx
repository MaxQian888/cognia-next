"use client"

import { useTranslations } from "next-intl"
import { ScissorsIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { CompressionSettings } from "@/types/system/compression"
import { DEFAULT_COMPRESSION_SETTINGS } from "@/types/system/compression"
import { listCompactionStrategyEntries } from "@/lib/plugin/registries/compaction-strategy-registry"
import { SettingsCard } from "../common/settings-section"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const BUILTIN_STRATEGY = "__builtin__"

/**
 * Settings → Conversation: context-compaction controls. Wires
 * `AppSettings.compaction` (Partial<CompressionSettings>) end-to-end — the
 * resolved config flows through `resolveSendOptions` to the sidecar. The
 * generic (AI-SDK) path honours every field; the Anthropic path uses the
 * compact instructions (focus) and the SDK owns its own threshold.
 */
export function CompactionSettings() {
  const t = useTranslations("settings.compaction")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const comp = settings?.compaction
  const enabled = comp?.enabled !== false
  const threshold = comp?.tokenThreshold ?? DEFAULT_COMPRESSION_SETTINGS.tokenThreshold
  const keepRecent =
    comp?.preserveRecentMessages ?? DEFAULT_COMPRESSION_SETTINGS.preserveRecentMessages
  const focus = comp?.focus ?? ""
  const strategyId = comp?.strategyId ?? BUILTIN_STRATEGY

  // Plugin-contributed strategies registered in the overlay registry.
  const pluginStrategies = listCompactionStrategyEntries()

  const saveComp = (patch: Partial<CompressionSettings>) =>
    void save({ compaction: { ...comp, ...patch } })

  return (
    <SettingsCard
      icon={<ScissorsIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-6">
        {/* Auto-compaction toggle */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="compaction-enabled">{t("enabled.heading")}</Label>
            <p className="text-sm text-muted-foreground">{t("enabled.description")}</p>
          </div>
          <Switch
            id="compaction-enabled"
            aria-label={t("enabled.label")}
            checked={enabled}
            onCheckedChange={(v) => saveComp({ enabled: v })}
          />
        </div>

        {enabled && (
          <>
            {/* Trigger threshold (% of window) */}
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="compaction-threshold">{t("threshold.heading")}</Label>
                <p className="text-sm text-muted-foreground">{t("threshold.description")}</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="compaction-threshold"
                  type="number"
                  min={10}
                  max={99}
                  className="w-20"
                  aria-label={t("threshold.label")}
                  value={threshold}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n >= 10 && n <= 99) saveComp({ tokenThreshold: n })
                  }}
                />
                <span className="text-sm text-muted-foreground">{t("threshold.suffix")}</span>
              </div>
            </div>

            {/* Keep-recent turns */}
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="compaction-keep-recent">{t("keepRecent.heading")}</Label>
                <p className="text-sm text-muted-foreground">{t("keepRecent.description")}</p>
              </div>
              <Input
                id="compaction-keep-recent"
                type="number"
                min={1}
                max={50}
                className="w-20"
                aria-label={t("keepRecent.label")}
                value={keepRecent}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n) && n >= 1 && n <= 50)
                    saveComp({ preserveRecentMessages: n })
                }}
              />
            </div>

            {/* Strategy picker (built-in + plugin-contributed) */}
            {pluginStrategies.length > 0 && (
              <div className="space-y-2">
                <div className="space-y-0.5">
                  <Label htmlFor="compaction-strategy">{t("strategy.heading")}</Label>
                  <p className="text-sm text-muted-foreground">{t("strategy.description")}</p>
                </div>
                <Select
                  value={strategyId}
                  onValueChange={(v) =>
                    saveComp({ strategyId: v === BUILTIN_STRATEGY ? undefined : v })
                  }
                >
                  <SelectTrigger id="compaction-strategy" aria-label={t("strategy.label")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BUILTIN_STRATEGY}>{t("strategy.builtin")}</SelectItem>
                    {pluginStrategies.map(({ id, entry }) => (
                      <SelectItem key={id} value={id}>
                        {entry.label ?? id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Compact instructions (focus) */}
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="compaction-focus">{t("focus.heading")}</Label>
                <p className="text-sm text-muted-foreground">{t("focus.description")}</p>
              </div>
              <Textarea
                id="compaction-focus"
                rows={3}
                aria-label={t("focus.label")}
                placeholder={t("focus.placeholder")}
                value={focus}
                onChange={(e) => saveComp({ focus: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
    </SettingsCard>
  )
}
