"use client"

/**
 * Agent-scoped `Character.compactionOverride` editor.
 *
 * Unlike most overrides this one is per FIELD: `resolveCompaction` resolves
 * each key session ← agent ← app independently, so every row has its own
 * inherit state (an "Inherit" option, or an empty number box). An edit that
 * leaves no key set writes `undefined` rather than `{}`.
 *
 * Option lists and labels are the app-level `CompactionSettings` ones
 * (`settings.compaction`); the number bounds match its inputs. That card saves
 * straight into app settings and has no inherit state, so the rows here are a
 * thin agent-scoped twin.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import type {
  CompressionStrategy,
  CompressionTrigger,
  SessionCompressionOverrides,
} from "@cognia/agent-config-types/compression"
import { OptionalNumberInput } from "@/components/settings/common/optional-number-input"
import { clampNumber } from "@/components/settings/common/clamped-number-input"
import { InheritBooleanSelect, InheritSelect } from "./inherit-select"

const STRATEGIES: CompressionStrategy[] = [
  "summary",
  "hybrid",
  "sliding-window",
  "selective",
  "recursive",
  "optical",
]
const TRIGGERS: CompressionTrigger[] = ["token-threshold", "message-count", "manual"]

type NumberKey = "tokenThreshold" | "messageCountThreshold" | "preserveRecentMessages"

/** Bounds and message keys of the numeric rows, mirroring `CompactionSettings`. */
const NUMBER_ROWS: ReadonlyArray<{ key: NumberKey; keyPath: string; min: number; max: number }> = [
  { key: "tokenThreshold", keyPath: "threshold", min: 10, max: 99 },
  { key: "messageCountThreshold", keyPath: "messageCount", min: 2, max: 500 },
  { key: "preserveRecentMessages", keyPath: "keepRecent", min: 1, max: 50 },
]

/** Empty text → inherit; anything numeric is clamped to the row's range. */
export function parseBoundedInteger(raw: string, min: number, max: number): number | undefined {
  if (raw.trim() === "") return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return clampNumber(parsed, min, max, true)
}

export interface CompactionOverrideProps {
  value: SessionCompressionOverrides | undefined
  onChange: (next: SessionCompressionOverrides | undefined) => void
}

export function CompactionOverride({ value, onChange }: CompactionOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.compaction")
  const tApp = useTranslations("settings.compaction")

  const patch = (next: Partial<SessionCompressionOverrides>) => {
    const merged: SessionCompressionOverrides = { ...value, ...next }
    for (const key of Object.keys(merged) as Array<keyof SessionCompressionOverrides>) {
      if (merged[key] === undefined) delete merged[key]
    }
    onChange(Object.keys(merged).length > 0 ? merged : undefined)
  }

  return (
    <div className="space-y-3" data-testid="agent-override-compaction">
      <div className="space-y-0.5">
        <Label className="text-xs font-medium">{t("title")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <InheritBooleanSelect
          id="agent-override-compaction-enabled"
          label={tApp("enabled.heading")}
          value={value?.compressionEnabled}
          onChange={(compressionEnabled) => patch({ compressionEnabled })}
        />
        <InheritSelect<CompressionStrategy>
          id="agent-override-compaction-strategy"
          label={tApp("algorithm.heading")}
          value={value?.compressionStrategy}
          options={STRATEGIES.map((s) => ({ value: s, label: tApp(`algorithm.options.${s}`) }))}
          onChange={(compressionStrategy) => patch({ compressionStrategy })}
        />
        <InheritSelect<CompressionTrigger>
          id="agent-override-compaction-trigger"
          label={tApp("trigger.heading")}
          value={value?.compressionTrigger}
          options={TRIGGERS.map((tr) => ({ value: tr, label: tApp(`trigger.options.${tr}`) }))}
          onChange={(compressionTrigger) => patch({ compressionTrigger })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {NUMBER_ROWS.map((row) => {
          const id = `agent-override-compaction-${row.key}`
          return (
            <div key={row.key} className="space-y-1">
              <Label htmlFor={id} className="text-xs">
                {tApp(`${row.keyPath}.heading`)}
              </Label>
              <OptionalNumberInput
                id={id}
                min={row.min}
                max={row.max}
                step={1}
                inputMode="numeric"
                className="h-8 text-xs"
                placeholder={t("inheritPlaceholder")}
                aria-label={tApp(`${row.keyPath}.label`)}
                value={value?.[row.key]}
                parse={(raw) => parseBoundedInteger(raw, row.min, row.max)}
                onCommit={(next) => patch({ [row.key]: next })}
              />
              <p className="text-[10px] text-muted-foreground">
                {t("range", { min: row.min, max: row.max })}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
