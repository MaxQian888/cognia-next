"use client"

import { useTranslations } from "next-intl"
import { ScissorsIcon } from "lucide-react"
import { getBuiltInProviderProtocol } from "@cognia/provider-types/built-in-provider-catalog"
import { useSettingsStore } from "@/stores/settings"
import type {
  CompressionSettings,
  CompressionStrategy,
  CompressionTrigger,
} from "@/types/system/compression"
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
const STRATEGIES: CompressionStrategy[] = [
  "summary",
  "hybrid",
  "sliding-window",
  "selective",
  "recursive",
]
const TRIGGERS: CompressionTrigger[] = ["token-threshold", "message-count", "manual"]

// Reusable rows — defined at module scope (not inside CompactionSettings) so
// React doesn't re-create them as fresh component types on every render. Each
// reads the same scoped translations directly.
function SwitchRow({
  id,
  keyPath,
  checked,
  onChange,
  disabled,
}: {
  id: string
  keyPath: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const t = useTranslations("settings.compaction")
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{t(`${keyPath}.heading`)}</Label>
        <p className="text-sm text-muted-foreground">{t(`${keyPath}.description`)}</p>
      </div>
      <Switch
        id={id}
        aria-label={t(`${keyPath}.label`)}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  )
}

function NumberRow({
  id,
  keyPath,
  value,
  min,
  max,
  suffix,
  onCommit,
  disabled,
}: {
  id: string
  keyPath: string
  value: number
  min: number
  max: number
  suffix?: boolean
  onCommit: (n: number) => void
  disabled?: boolean
}) {
  const t = useTranslations("settings.compaction")
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{t(`${keyPath}.heading`)}</Label>
        <p className="text-sm text-muted-foreground">{t(`${keyPath}.description`)}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          className="w-24"
          aria-label={t(`${keyPath}.label`)}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= min && n <= max) onCommit(n)
          }}
        />
        {suffix && <span className="text-sm text-muted-foreground">{t(`${keyPath}.suffix`)}</span>}
      </div>
    </div>
  )
}

/**
 * Settings → Conversation: context-compaction controls. Wires
 * `AppSettings.compaction` (Partial<CompressionSettings>) end-to-end — the
 * resolved config flows through `resolveSendOptions` to the sidecar. The
 * generic (AI-SDK) path honours every field; the Anthropic path self-manages
 * compaction, so only `enabled`, `focus`, and the notification toggle apply
 * there — the rest are disabled with an explanatory note.
 */
export function CompactionSettings() {
  const t = useTranslations("settings.compaction")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)

  const comp = settings?.compaction
  const D = DEFAULT_COMPRESSION_SETTINGS
  const enabled = comp?.enabled !== false
  const threshold = comp?.tokenThreshold ?? D.tokenThreshold
  const keepRecent = comp?.preserveRecentMessages ?? D.preserveRecentMessages
  const focus = comp?.focus ?? ""
  const strategyId = comp?.strategyId ?? BUILTIN_STRATEGY
  const strategy = comp?.strategy ?? D.strategy
  const trigger = comp?.trigger ?? D.trigger
  const messageCountThreshold = comp?.messageCountThreshold ?? D.messageCountThreshold
  const retainedThreshold = comp?.retainedThreshold ?? D.retainedThreshold
  const importanceThreshold = comp?.importanceThreshold ?? D.importanceThreshold
  const recursiveChunkSize = comp?.recursiveChunkSize ?? D.recursiveChunkSize
  const maxToolResultTokens = comp?.maxToolResultTokens ?? D.maxToolResultTokens
  const preserveToolCallMetadata = comp?.preserveToolCallMetadata ?? D.preserveToolCallMetadata
  const preserveSystemMessages = comp?.preserveSystemMessages ?? D.preserveSystemMessages
  const useAISummarization = comp?.useAISummarization ?? D.useAISummarization
  const showNotification = comp?.showCompressionNotification ?? D.showCompressionNotification
  const enableUndo = comp?.enableUndo ?? D.enableUndo

  // The global card applies to the default provider's path. Anthropic self-
  // manages compaction; only focus / notifications take effect there.
  const isAnthropicPath =
    (defaultProvider ?? "anthropic") === "anthropic" ||
    getBuiltInProviderProtocol(defaultProvider ?? "") === "anthropic"

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
        <SwitchRow
          id="compaction-enabled"
          keyPath="enabled"
          checked={enabled}
          onChange={(v) => saveComp({ enabled: v })}
        />

        {enabled && (
          <>
            {isAnthropicPath && (
              <div
                className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
                data-testid="compaction-anthropic-notice"
              >
                <p className="text-sm font-medium">{t("anthropicNotice.heading")}</p>
                <p className="text-sm text-muted-foreground">{t("anthropicNotice.description")}</p>
              </div>
            )}

            {/* Strategy algorithm */}
            <div
              className="space-y-2"
              title={isAnthropicPath ? t("anthropicNotice.fieldDisabledTooltip") : undefined}
            >
              <div className="space-y-0.5">
                <Label htmlFor="compaction-algorithm">{t("algorithm.heading")}</Label>
                <p className="text-sm text-muted-foreground">{t("algorithm.description")}</p>
              </div>
              <Select
                value={strategy}
                disabled={isAnthropicPath}
                onValueChange={(v) => saveComp({ strategy: v as CompressionStrategy })}
              >
                <SelectTrigger id="compaction-algorithm" aria-label={t("algorithm.label")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRATEGIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`algorithm.options.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Trigger mode */}
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="compaction-trigger">{t("trigger.heading")}</Label>
                <p className="text-sm text-muted-foreground">{t("trigger.description")}</p>
              </div>
              <Select
                value={trigger}
                disabled={isAnthropicPath}
                onValueChange={(v) => saveComp({ trigger: v as CompressionTrigger })}
              >
                <SelectTrigger id="compaction-trigger" aria-label={t("trigger.label")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGERS.map((tr) => (
                    <SelectItem key={tr} value={tr}>
                      {t(`trigger.options.${tr}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {trigger !== "message-count" && (
              <NumberRow
                id="compaction-threshold"
                keyPath="threshold"
                value={threshold}
                min={10}
                max={99}
                suffix
                disabled={isAnthropicPath}
                onCommit={(n) => saveComp({ tokenThreshold: n })}
              />
            )}
            {trigger === "message-count" && (
              <NumberRow
                id="compaction-message-count"
                keyPath="messageCount"
                value={messageCountThreshold}
                min={2}
                max={500}
                disabled={isAnthropicPath}
                onCommit={(n) => saveComp({ messageCountThreshold: n })}
              />
            )}

            <NumberRow
              id="compaction-keep-recent"
              keyPath="keepRecent"
              value={keepRecent}
              min={1}
              max={50}
              disabled={isAnthropicPath}
              onCommit={(n) => saveComp({ preserveRecentMessages: n })}
            />

            <NumberRow
              id="compaction-retained"
              keyPath="retained"
              value={retainedThreshold}
              min={10}
              max={90}
              suffix
              disabled={isAnthropicPath}
              onCommit={(n) => saveComp({ retainedThreshold: n })}
            />

            {strategy === "selective" && (
              <NumberRow
                id="compaction-importance"
                keyPath="importance"
                value={Math.round(importanceThreshold * 100)}
                min={0}
                max={100}
                suffix
                disabled={isAnthropicPath}
                onCommit={(n) => saveComp({ importanceThreshold: n / 100 })}
              />
            )}

            {strategy === "recursive" && (
              <NumberRow
                id="compaction-chunk-size"
                keyPath="recursiveChunkSize"
                value={recursiveChunkSize}
                min={2}
                max={100}
                disabled={isAnthropicPath}
                onCommit={(n) => saveComp({ recursiveChunkSize: n })}
              />
            )}

            <NumberRow
              id="compaction-tool-cap"
              keyPath="toolResultCap"
              value={maxToolResultTokens}
              min={50}
              max={5000}
              disabled={isAnthropicPath}
              onCommit={(n) => saveComp({ maxToolResultTokens: n })}
            />

            <SwitchRow
              id="compaction-preserve-tool-meta"
              keyPath="preserveToolMeta"
              checked={preserveToolCallMetadata}
              disabled={isAnthropicPath}
              onChange={(v) => saveComp({ preserveToolCallMetadata: v })}
            />

            <SwitchRow
              id="compaction-preserve-system"
              keyPath="preserveSystem"
              checked={preserveSystemMessages}
              disabled={isAnthropicPath}
              onChange={(v) => saveComp({ preserveSystemMessages: v })}
            />

            <SwitchRow
              id="compaction-use-ai"
              keyPath="useAISummarization"
              checked={useAISummarization}
              disabled={isAnthropicPath}
              onChange={(v) => saveComp({ useAISummarization: v })}
            />

            <SwitchRow
              id="compaction-undo"
              keyPath="enableUndo"
              checked={enableUndo}
              disabled={isAnthropicPath}
              onChange={(v) => saveComp({ enableUndo: v })}
            />

            {/* Plugin strategy picker (built-in + plugin-contributed) */}
            {pluginStrategies.length > 0 && (
              <div className="space-y-2">
                <div className="space-y-0.5">
                  <Label htmlFor="compaction-strategy">{t("strategy.heading")}</Label>
                  <p className="text-sm text-muted-foreground">{t("strategy.description")}</p>
                </div>
                <Select
                  value={strategyId}
                  disabled={isAnthropicPath}
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

            {/* Notification toggle — applies on BOTH paths (the boundary event
                arrives on each). */}
            <SwitchRow
              id="compaction-notify"
              keyPath="notify"
              checked={showNotification}
              onChange={(v) => saveComp({ showCompressionNotification: v })}
            />

            {/* Compact instructions (focus) — applies on both paths. */}
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
