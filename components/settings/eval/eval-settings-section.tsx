"use client"

/**
 * Settings → Agent 评估 — project-level eval defaults that previously had no
 * home (they could only be set per-run). Four blocks:
 *   1. Judge      — which model runs the LLM scorers + a deterministic-only kill switch.
 *   2. Run        — default k (pass^k), default scorer selection (grouped
 *                  picker), and how much of each answer to keep on the result
 *                  row (`maxStoredOutputChars`: the one EvalSettings field the
 *                  page used to omit, so `resolveEvalSettings` always clamped
 *                  it back to the default and error analysis was stuck with
 *                  whatever that was).
 *   3. Gate       — thresholds stamped onto brand-new datasets (collapsible).
 *   4. Cost guard — warn before an expensive run (collapsible).
 * Everything persists to `AppSettings.evalSettings` (one Dexie write); the
 * run-config dialog and `createDataset` read it back through `resolveEvalSettings`.
 *
 * Layout: this page is a short, flat form — four groups of at most four fields —
 * so it is a plain `SettingsStack`, not a stack of cards. The two advanced
 * groups (gate thresholds, cost guard) fold away behind a disclosure instead of
 * each claiming a bordered box of its own.
 */

import { useEffect, useMemo, useRef, useState } from "react"
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
  Loader2Icon,
  InfoIcon,
  AlertTriangleIcon,
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
import { Switch } from "@/components/ui/switch"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import {
  ScorerPicker,
  expandScorerSelection,
  normalizeScorerSelection,
} from "@/components/eval/scorer-picker"
import { ALL_SCORER_IDS } from "@cognia/eval-core/scorers/catalog"
import { resolveEvalSettings, EVAL_K_RANGE } from "@/lib/ai/eval/settings"
import { MAX_STORED_OUTPUT_CHARS, type EvalSettings } from "@/types/eval/settings"
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
          className="w-full justify-between gap-2 font-mono text-xs sm:w-[220px]"
          aria-label={t("judgeModelLabel")}
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">{value ? value : t("judgeModelAuto")}</span>
          </span>
          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[var(--radix-popover-trigger-width)] p-0 sm:w-[320px]"
      >
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

  // Auto-save is fire-and-forget from the user's point of view; surface a small
  // transient status pill so a persisted change is visibly acknowledged.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle")
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    },
    []
  )

  const runSave = async (payload: { evalSettings: EvalSettings }) => {
    setSaveState("saving")
    try {
      await save(payload)
      setSaveState("saved")
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaveState("idle"), 1500)
    } catch {
      setSaveState("idle")
    }
  }

  const patch = (next: Partial<EvalSettings>) => {
    void runSave({ evalSettings: { ...resolved, ...next } })
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

  // Gate feedback: whether any threshold is set, and whether pass^k > pass@1
  // (logically impossible — pass^k can never exceed pass@1 for the same run).
  const gateActive = Object.keys(gate).length > 0
  const gateInconsistent =
    typeof gate.minPassAt1 === "number" &&
    typeof gate.minPassHatK === "number" &&
    gate.minPassHatK > gate.minPassAt1

  // Scorer summary for the Run card.
  const selectedScorerCount = expandScorerSelection(resolved.defaultScorerIds).length
  const totalScorerCount = ALL_SCORER_IDS.length

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="eval-settings-section">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <ClipboardCheckIcon className="size-4 text-muted-foreground" />
            {t("title")}
          </h2>
          <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveState !== "idle" && (
            <span
              role="status"
              aria-live="polite"
              data-testid="eval-save-status"
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              {saveState === "saving" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5 text-emerald-500" />
              )}
              {saveState === "saving" ? t("saving") : t("saved")}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => router.push("/eval")}>
            <ExternalLinkIcon className="size-4" />
            {t("openWorkspace")}
          </Button>
        </div>
      </div>

      <SettingsStack>
        {/* 1. Judge */}
        <SettingsBlock
          icon={<ScaleIcon />}
          title={t("judgeTitle")}
          testid="eval-block-judge"
          contentClassName="space-y-0 [&>*+*]:pt-4"
        >
          <SettingsField
            label={t("judgeModelLabel")}
            description={t("judgeModelDescription")}
            disabled={deterministicOnly}
          >
            <JudgeModelPicker
              value={resolved.judgeModel}
              onSelect={(modelId) => patch({ judgeModel: modelId })}
              disabled={deterministicOnly}
            />
          </SettingsField>
          <SettingsField
            htmlFor="eval-deterministic-only"
            label={t("deterministicLabel")}
            description={t("deterministicDescription")}
          >
            <Switch
              id="eval-deterministic-only"
              checked={deterministicOnly}
              onCheckedChange={(v) => patch({ deterministicOnly: v })}
            />
          </SettingsField>
          {deterministicOnly && (
            <SettingsAlert icon={<InfoIcon className="size-4" />}>
              {t("deterministicActiveHint")}
            </SettingsAlert>
          )}
        </SettingsBlock>

        {/* 2. Run defaults */}
        <SettingsBlock
          icon={<PlayIcon />}
          title={t("runTitle")}
          testid="eval-block-run"
          contentClassName="space-y-0 [&>*+*]:pt-4"
        >
          <SettingsField label={t("defaultKLabel")} description={t("defaultKDescription")}>
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
          </SettingsField>
          {/* The scorer picker is a full-width grid of toggles — it gets its own
              line rather than being squeezed into a right-hand control slot. */}
          <SettingsField
            label={t("defaultScorersLabel")}
            description={t("defaultScorersDescription")}
            stacked
          >
            <div className="space-y-2">
              <p className="text-xs tabular-nums text-muted-foreground">
                {t("scorersSelectedSummary", {
                  count: selectedScorerCount,
                  total: totalScorerCount,
                })}
              </p>
              <ScorerPicker
                value={expandScorerSelection(resolved.defaultScorerIds)}
                onChange={(ids) => patch({ defaultScorerIds: normalizeScorerSelection(ids) })}
                judgeAvailable={!deterministicOnly}
              />
            </div>
          </SettingsField>
          <SettingsField
            label={t("storedOutputLabel")}
            description={
              resolved.maxStoredOutputChars === 0
                ? t("storedOutputDisabledDescription")
                : t("storedOutputDescription")
            }
          >
            <Input
              type="number"
              min={0}
              max={MAX_STORED_OUTPUT_CHARS}
              step={500}
              aria-label={t("storedOutputLabel")}
              value={resolved.maxStoredOutputChars}
              onChange={(e) =>
                patch({
                  maxStoredOutputChars:
                    parseOptionalNumber(e.target.value, 0, MAX_STORED_OUTPUT_CHARS) ?? 0,
                })
              }
              className="h-8 w-28"
              data-testid="eval-stored-output"
            />
          </SettingsField>
        </SettingsBlock>

        {/* 3. Gate defaults — advanced, so it folds away. */}
        <SettingsBlock
          icon={<ShieldCheckIcon />}
          title={t("gateTitle")}
          description={t("gateDescription")}
          badge={
            <Badge variant={gateActive ? "default" : "outline"} className="text-[10px]">
              {gateActive ? t("gateActive") : t("gateInactive")}
            </Badge>
          }
          collapsible
          testid="eval-block-gate"
        >
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 @md/settings-stack:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                {t("gateMinPassAt1")}
              </span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                aria-label={t("gateMinPassAt1")}
                value={gate.minPassAt1 ?? ""}
                onChange={(e) =>
                  patchGate({ minPassAt1: parseOptionalNumber(e.target.value, 0, 1) })
                }
                className="h-8"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                {t("gateMinPassHatK")}
              </span>
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
              <span className="text-xs font-medium text-muted-foreground">
                {t("gateMinScorerPassRate")}
              </span>
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
              <span className="text-xs font-medium text-muted-foreground">{t("gateMaxCost")}</span>
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
          {gateInconsistent && (
            <SettingsAlert variant="destructive" icon={<AlertTriangleIcon className="size-4" />}>
              {t("gateInconsistent")}
            </SettingsAlert>
          )}
        </SettingsBlock>

        {/* 4. Cost guard */}
        <SettingsBlock
          icon={<CoinsIcon />}
          title={t("costTitle")}
          collapsible
          testid="eval-block-cost"
        >
          <SettingsField label={t("costWarnLabel")} description={t("costWarnDescription")}>
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
          </SettingsField>
        </SettingsBlock>
      </SettingsStack>
    </div>
  )
}
