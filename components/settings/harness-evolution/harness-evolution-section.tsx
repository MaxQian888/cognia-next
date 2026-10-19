"use client"

/**
 * Settings → Harness Evolution (ADR-0237). The feature flag (off by default),
 * how far runs may start by themselves, defaults for new runs, the budget
 * ceilings, which model plays each role, what probes may reach, and the
 * background and failure-offer pacing. Everything persists to
 * `AppSettings.harnessEvolution`; `resolveHarnessEvolutionSettings` clamps it
 * on read, and the inputs clamp to the same ranges.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, CoinsIcon, DnaIcon, PlayIcon, ShieldCheckIcon, TimerIcon } from "lucide-react"
import type { StoredHarnessEvolutionSettings } from "@cognia/agent-config-types"
import { HARNESS_EVOLUTION_START_MODES } from "@cognia/agent-config-types"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { BUDGET_LIMITS, K_MAX, K_MIN } from "@/lib/harness/budget"
import { harnessEvolutionSettingsOf } from "@/lib/harness/settings"
import { useSettingsStore } from "@/stores/settings"
import {
  HARNESS_EVOLUTION_MODES,
  HARNESS_ROLES,
  type HarnessEvolutionBudget,
} from "@/types/harness/evolution"
import { HarnessRoleModelPicker } from "./harness-role-model-picker"

const MINUTE = 60_000

export function HarnessEvolutionSection() {
  const t = useTranslations("harnessEvolution.settings")
  const tRoot = useTranslations("harnessEvolution")
  const appSettings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const stored = appSettings?.harnessEvolution
  const settings = useMemo(() => harnessEvolutionSettingsOf(appSettings), [appSettings])
  const servers = useLiveQuery(
    () => import("@/lib/db/mcp-servers").then((m) => m.listMcpServers()),
    []
  )

  const patch = (next: Partial<StoredHarnessEvolutionSettings>) =>
    save({ harnessEvolution: { ...(stored ?? {}), ...next } })
  const patchBudget = (next: Partial<HarnessEvolutionBudget>) =>
    patch({ budget: { ...(stored?.budget ?? {}), ...next } })
  const off = !settings.enabled

  const budgetField = (key: keyof HarnessEvolutionBudget, scale = 1, integer = true) => {
    const [min, max] = BUDGET_LIMITS[key]
    return (
      <SettingsField
        key={key}
        htmlFor={`harness-budget-${key}`}
        label={t(`budget.${key}.label`)}
        description={t(`budget.${key}.description`)}
        disabled={off}
      >
        <ClampedNumberInput
          id={`harness-budget-${key}`}
          className="w-28"
          value={settings.budget[key] / scale}
          min={min / scale}
          max={max / scale}
          integer={integer}
          commitWhileTyping={false}
          onCommit={(v) => void patchBudget({ [key]: v * scale })}
        />
      </SettingsField>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="harness-evolution-section">
      <div className="min-w-0 space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <DnaIcon className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
      </div>

      <SettingsStack>
        <SettingsBlock
          icon={<DnaIcon />}
          title={t("enableTitle")}
          testid="harness-block-enable"
          settingId="harness-evolution-enabled"
        >
          <SettingsField
            htmlFor="harness-enabled"
            label={t("enabled")}
            description={t("enabledDescription")}
          >
            <Switch
              id="harness-enabled"
              checked={settings.enabled}
              onCheckedChange={(v) => void patch({ enabled: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-start-mode"
            label={t("startMode")}
            description={t(`startModeDescription.${settings.startMode}`)}
            disabled={off}
          >
            <NativeSelect
              id="harness-start-mode"
              value={settings.startMode}
              onChange={(e) =>
                void patch({
                  startMode: e.target.value as StoredHarnessEvolutionSettings["startMode"],
                })
              }
            >
              {HARNESS_EVOLUTION_START_MODES.map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {t(`startModes.${m}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingsField>
          {off ? (
            <SettingsAlert icon={<ShieldCheckIcon className="size-4" />}>
              {t("offHint")}
            </SettingsAlert>
          ) : null}
        </SettingsBlock>

        <SettingsBlock
          icon={<PlayIcon />}
          title={t("defaultsTitle")}
          testid="harness-block-defaults"
        >
          <SettingsField
            htmlFor="harness-default-mode"
            label={t("defaultMode")}
            description={t("defaultModeDescription")}
            disabled={off}
          >
            <NativeSelect
              id="harness-default-mode"
              value={settings.defaultMode}
              onChange={(e) =>
                void patch({ defaultMode: e.target.value as "parallel" | "sequential" })
              }
            >
              {HARNESS_EVOLUTION_MODES.map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {tRoot(`mode.${m}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingsField>
          <SettingsField
            htmlFor="harness-default-k"
            label={t("defaultK")}
            description={t("defaultKDescription")}
            disabled={off}
          >
            <ClampedNumberInput
              id="harness-default-k"
              className="w-20"
              value={settings.defaultK}
              min={K_MIN}
              max={K_MAX}
              integer
              commitWhileTyping={false}
              onCommit={(v) => void patch({ defaultK: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-editor-channel"
            label={t("editorChannel")}
            description={t(`editorChannelDescription.${settings.editorChannel}`)}
            disabled={off}
          >
            <NativeSelect
              id="harness-editor-channel"
              value={settings.editorChannel}
              onChange={(e) =>
                void patch({ editorChannel: e.target.value as "auto" | "agentic" | "structured" })
              }
            >
              {(["auto", "agentic", "structured"] as const).map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {t(`editorChannels.${c}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingsField>
          <SettingsField
            htmlFor="harness-use-experiences"
            label={t("useExperiences")}
            description={t("useExperiencesDescription")}
            disabled={off}
          >
            <Switch
              id="harness-use-experiences"
              checked={settings.useExperiences}
              onCheckedChange={(v) => void patch({ useExperiences: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-auto-adopt"
            label={t("autoAdopt")}
            description={t("autoAdoptDescription")}
            disabled={off}
          >
            <Switch
              id="harness-auto-adopt"
              checked={settings.autoAdoptLowRisk}
              onCheckedChange={(v) => void patch({ autoAdoptLowRisk: v })}
            />
          </SettingsField>
        </SettingsBlock>

        <SettingsBlock
          icon={<CoinsIcon />}
          title={t("budgetTitle")}
          description={t("budgetDescription")}
          testid="harness-block-budget"
          collapsible
          defaultOpen={false}
        >
          {budgetField("maxCostUsd", 1, false)}
          {budgetField("maxTokens")}
          {budgetField("maxModelCalls")}
          {budgetField("maxWallTimeMs", MINUTE)}
          {budgetField("maxIterations")}
          {budgetField("maxCandidates")}
          {budgetField("maxParallelRuns")}
          {budgetField("maxTurnsPerRollout")}
        </SettingsBlock>

        <SettingsBlock
          icon={<BotIcon />}
          title={t("modelsTitle")}
          description={t("modelsDescription")}
          testid="harness-block-models"
          collapsible
          defaultOpen={false}
        >
          {HARNESS_ROLES.map((role) => (
            <SettingsField
              key={role}
              label={t(`role.${role}`)}
              description={t(`roleDescription.${role}`)}
              disabled={off}
            >
              <HarnessRoleModelPicker
                role={role}
                value={settings.models[role]}
                onChange={(next) => {
                  const models = { ...(stored?.models ?? {}) }
                  if (next) models[role] = next
                  else delete models[role]
                  void patch({ models })
                }}
              />
            </SettingsField>
          ))}
        </SettingsBlock>

        <SettingsBlock
          icon={<ShieldCheckIcon />}
          title={t("probeTitle")}
          description={t("probeDescription")}
          testid="harness-block-probe"
          collapsible
          defaultOpen={false}
        >
          {servers === undefined ? null : servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noMcpServers")}</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="harness-probe-mcp">
              {servers.map((server) => {
                const checked = settings.probeAllowedMcpServerIds.includes(server.id)
                return (
                  <li key={server.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
                        disabled={off}
                        onCheckedChange={(v) =>
                          void patch({
                            probeAllowedMcpServerIds:
                              v === true
                                ? [...settings.probeAllowedMcpServerIds, server.id]
                                : settings.probeAllowedMcpServerIds.filter(
                                    (id) => id !== server.id
                                  ),
                          })
                        }
                      />
                      {server.name}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </SettingsBlock>

        <SettingsBlock
          icon={<TimerIcon />}
          title={t("pacingTitle")}
          testid="harness-block-pacing"
          collapsible
          defaultOpen={false}
        >
          <SettingsField
            htmlFor="harness-cooldown"
            label={t("cooldown")}
            description={t("cooldownDescription")}
            disabled={off}
          >
            <ClampedNumberInput
              id="harness-cooldown"
              className="w-24"
              value={settings.failureOfferCooldownHours}
              min={0}
              max={24 * 7}
              integer
              commitWhileTyping={false}
              onCommit={(v) => void patch({ failureOfferCooldownHours: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-bg-interval"
            label={t("backgroundInterval")}
            description={t("backgroundIntervalDescription")}
            disabled={off || settings.startMode !== "background"}
          >
            <ClampedNumberInput
              id="harness-bg-interval"
              className="w-24"
              value={settings.backgroundIntervalHours}
              min={1}
              max={24 * 14}
              integer
              commitWhileTyping={false}
              onCommit={(v) => void patch({ backgroundIntervalHours: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-bg-runs"
            label={t("backgroundRuns")}
            description={t("backgroundRunsDescription")}
            disabled={off || settings.startMode !== "background"}
          >
            <ClampedNumberInput
              id="harness-bg-runs"
              className="w-20"
              value={settings.backgroundMaxRunsPerSweep}
              min={1}
              max={5}
              integer
              commitWhileTyping={false}
              onCommit={(v) => void patch({ backgroundMaxRunsPerSweep: v })}
            />
          </SettingsField>
          <SettingsField
            htmlFor="harness-exp-cap"
            label={t("experienceCap")}
            description={t("experienceCapDescription")}
            disabled={off}
          >
            <ClampedNumberInput
              id="harness-exp-cap"
              className="w-24"
              value={settings.experienceCapPerAgent}
              min={20}
              max={2000}
              integer
              commitWhileTyping={false}
              onCommit={(v) => void patch({ experienceCapPerAgent: v })}
            />
          </SettingsField>
        </SettingsBlock>
      </SettingsStack>
    </div>
  )
}
