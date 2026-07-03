"use client"

/**
 * Settings → Agent 评估 — project-level eval defaults that previously had no
 * home (they could only be set per-run). Four cards:
 *   1. Judge      — which model runs the LLM scorers + a deterministic-only kill switch.
 *   2. Run        — default k (pass^k) + default scorer selection (grouped picker).
 *   3. Gate       — thresholds stamped onto brand-new datasets.
 *   4. Cost guard — warn before an expensive run.
 * Everything persists to `AppSettings.evalSettings` (one Dexie write); the
 * run-config dialog and `createDataset` read it back through `resolveEvalSettings`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ClipboardCheckIcon,
  ScaleIcon,
  PlayIcon,
  ShieldCheckIcon,
  CoinsIcon,
  CpuIcon,
  ChevronsUpDownIcon,
  CheckIcon,
  ExternalLinkIcon,
} from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import {
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsPageHeader,
} from "@/components/settings/common/settings-section"
import {
  ScorerPicker,
  expandScorerSelection,
  normalizeScorerSelection,
} from "@/components/eval/scorer-picker"
import { resolveEvalSettings, EVAL_K_RANGE } from "@/lib/ai/eval/settings"
import type { EvalSettings } from "@/types/eval/settings"
import type { GateThresholds } from "@/types/eval/gate"

/** Parse a bounded numeric field; empty string → undefined (clears the field). */
function parseOptionalNumber(raw: string, min: number, max: number): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, n))
}

function JudgeModelPicker({
  value,
  onSelect,
  disabled,
}: {
  value: string | undefined
  onSelect: (modelId: string | undefined) => void
  disabled?: boolean
}) {
  const t = useTranslations("eval.settings")
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const [open, setOpen] = useState(false)

  const groups = useMemo(
    () => groupByProvider(collectOptions(providerSettings, customProviders)),
    [providerSettings, customProviders]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="w-[220px] justify-between gap-2 font-mono text-xs"
          aria-label={t("judgeModelLabel")}
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">{value ? value : t("judgeModelAuto")}</span>
          </span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <Command>
          <CommandInput placeholder={t("judgeModelSearch")} />
          <CommandList>
            {groups.length === 0 ? (
              <CommandEmpty>{t("judgeModelEmpty")}</CommandEmpty>
            ) : (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__auto__"
                    onSelect={() => {
                      setOpen(false)
                      onSelect(undefined)
                    }}
                  >
                    <CheckIcon className={cn("mr-2 size-4", value ? "opacity-0" : "opacity-100")} />
                    <span className="text-xs">{t("judgeModelAuto")}</span>
                  </CommandItem>
                </CommandGroup>
                {groups.map((group) => (
                  <div key={group.providerId}>
                    <CommandSeparator />
                    <CommandGroup heading={group.providerName}>
                      {group.models.map((modelId) => (
                        <CommandItem
                          key={`${group.providerId}:${modelId}`}
                          value={`${group.providerId} ${modelId}`}
                          onSelect={() => {
                            setOpen(false)
                            onSelect(modelId)
                          }}
                        >
                          <CheckIcon
                            className={cn(
                              "mr-2 size-4",
                              value === modelId ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="font-mono text-xs">{modelId}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </div>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function EvalSettingsSection() {
  const t = useTranslations("eval.settings")
  const router = useRouter()
  const appSettings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const resolved = useMemo(() => resolveEvalSettings(appSettings), [appSettings])

  const patch = (next: Partial<EvalSettings>) => {
    void save({ evalSettings: { ...resolved, ...next } })
  }

  const patchGate = (next: Partial<GateThresholds>) => {
    const merged: GateThresholds = { ...(resolved.defaultGate ?? {}), ...next }
    // Drop empty keys so an all-empty gate persists as "no gate".
    const cleaned = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined)
    ) as GateThresholds
    patch({ defaultGate: Object.keys(cleaned).length > 0 ? cleaned : undefined })
  }

  const deterministicOnly = resolved.deterministicOnly ?? false
  const gate = resolved.defaultGate ?? {}
  const minScorerPassRate =
    typeof gate.minScorerPassRate === "number" ? gate.minScorerPassRate : undefined

  return (
    <div className="space-y-4" data-testid="eval-settings-section">
      <SettingsPageHeader
        icon={<ClipboardCheckIcon className="size-5" />}
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="outline" size="sm" onClick={() => router.push("/eval")}>
            <ExternalLinkIcon className="size-4" />
            {t("openWorkspace")}
          </Button>
        }
      />

      {/* 1. Judge */}
      <SettingsCard icon={<ScaleIcon className="size-4" />} title={t("judgeTitle")}>
        <SettingsRow label={t("judgeModelLabel")} description={t("judgeModelDescription")}>
          <JudgeModelPicker
            value={resolved.judgeModel}
            onSelect={(modelId) => patch({ judgeModel: modelId })}
            disabled={deterministicOnly}
          />
        </SettingsRow>
        <SettingsToggle
          id="eval-deterministic-only"
          label={t("deterministicLabel")}
          description={t("deterministicDescription")}
          checked={deterministicOnly}
          onCheckedChange={(v) => patch({ deterministicOnly: v })}
        />
      </SettingsCard>

      {/* 2. Run defaults */}
      <SettingsCard icon={<PlayIcon className="size-4" />} title={t("runTitle")}>
        <SettingsRow label={t("defaultKLabel")} description={t("defaultKDescription")}>
          <Input
            type="number"
            min={EVAL_K_RANGE.min}
            max={EVAL_K_RANGE.max}
            aria-label={t("defaultKLabel")}
            value={resolved.defaultK}
            onChange={(e) =>
              patch({
                defaultK:
                  parseOptionalNumber(e.target.value, EVAL_K_RANGE.min, EVAL_K_RANGE.max) ??
                  EVAL_K_RANGE.min,
              })
            }
            className="h-8 w-20"
          />
        </SettingsRow>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("defaultScorersLabel")}</p>
          <p className="text-muted-foreground text-xs">{t("defaultScorersDescription")}</p>
          <ScorerPicker
            value={expandScorerSelection(resolved.defaultScorerIds)}
            onChange={(ids) => patch({ defaultScorerIds: normalizeScorerSelection(ids) })}
            judgeAvailable={!deterministicOnly}
          />
        </div>
      </SettingsCard>

      {/* 3. Gate defaults */}
      <SettingsCard
        icon={<ShieldCheckIcon className="size-4" />}
        title={t("gateTitle")}
        description={t("gateDescription")}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("gateMinPassAt1")}</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label={t("gateMinPassAt1")}
              value={gate.minPassAt1 ?? ""}
              onChange={(e) => patchGate({ minPassAt1: parseOptionalNumber(e.target.value, 0, 1) })}
              className="h-8"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("gateMinPassHatK")}</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label={t("gateMinPassHatK")}
              value={gate.minPassHatK ?? ""}
              onChange={(e) =>
                patchGate({ minPassHatK: parseOptionalNumber(e.target.value, 0, 1) })
              }
              className="h-8"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("gateMinScorerPassRate")}</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label={t("gateMinScorerPassRate")}
              value={minScorerPassRate ?? ""}
              onChange={(e) =>
                patchGate({ minScorerPassRate: parseOptionalNumber(e.target.value, 0, 1) })
              }
              className="h-8"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("gateMaxCost")}</span>
            <Input
              type="number"
              min={0}
              step={0.5}
              aria-label={t("gateMaxCost")}
              value={gate.maxTotalCostUsd ?? ""}
              onChange={(e) =>
                patchGate({ maxTotalCostUsd: parseOptionalNumber(e.target.value, 0, 1_000_000) })
              }
              className="h-8"
            />
          </label>
        </div>
      </SettingsCard>

      {/* 4. Cost guard */}
      <SettingsCard icon={<CoinsIcon className="size-4" />} title={t("costTitle")}>
        <SettingsRow label={t("costWarnLabel")} description={t("costWarnDescription")}>
          <Input
            type="number"
            min={0}
            step={0.5}
            aria-label={t("costWarnLabel")}
            value={resolved.costWarnUsd ?? ""}
            onChange={(e) =>
              patch({ costWarnUsd: parseOptionalNumber(e.target.value, 0, 1_000_000) })
            }
            className="h-8 w-24"
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
