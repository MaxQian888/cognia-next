/**
 * Harness Evolution preferences, normalised (ADR-0237).
 *
 * `AppSettings.harnessEvolution` is stored as the user left it; everything
 * that reads it goes through {@link resolveHarnessEvolutionSettings}, which
 * fills defaults and clamps every number, so a hand-edited or older row can
 * never ask for an unbounded run. Absent means the feature is off.
 */

import type {
  AppSettings,
  HarnessEvolutionStartMode,
  StoredHarnessEvolutionSettings,
} from "@cognia/agent-config-types"
import { HARNESS_EVOLUTION_START_MODES } from "@cognia/agent-config-types/agent-harness"
import type {
  HarnessEditorChannel,
  HarnessEvolutionBudget,
  HarnessEvolutionMode,
  HarnessRoleModels,
} from "@/types/harness/evolution"
import { HARNESS_ROLES } from "@/types/harness/evolution"
import { effectiveK, normalizeBudget } from "./budget"

export interface HarnessEvolutionSettings {
  enabled: boolean
  startMode: HarnessEvolutionStartMode
  defaultMode: HarnessEvolutionMode
  defaultK: number
  budget: HarnessEvolutionBudget
  autoAdoptLowRisk: boolean
  useExperiences: boolean
  editorChannel: HarnessEditorChannel
  models: HarnessRoleModels
  probeAllowedMcpServerIds: string[]
  backgroundIntervalHours: number
  backgroundMaxRunsPerSweep: number
  failureOfferCooldownHours: number
  experienceCapPerAgent: number
}

export const DEFAULT_HARNESS_EVOLUTION_SETTINGS: HarnessEvolutionSettings = {
  enabled: false,
  startMode: "manual",
  defaultMode: "parallel",
  defaultK: 1,
  budget: normalizeBudget(undefined),
  autoAdoptLowRisk: false,
  useExperiences: true,
  editorChannel: "auto",
  models: {},
  probeAllowedMcpServerIds: [],
  backgroundIntervalHours: 24,
  backgroundMaxRunsPerSweep: 1,
  failureOfferCooldownHours: 6,
  experienceCapPerAgent: 200,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function resolveHarnessEvolutionSettings(
  stored: StoredHarnessEvolutionSettings | undefined | null
): HarnessEvolutionSettings {
  const d = DEFAULT_HARNESS_EVOLUTION_SETTINGS
  if (!stored || typeof stored !== "object") return { ...d, budget: { ...d.budget } }
  const budget = normalizeBudget(stored.budget)
  const models: HarnessRoleModels = {}
  for (const role of HARNESS_ROLES) {
    const raw = stored.models?.[role]
    const providerId = nonEmpty(raw?.providerId)
    const model = nonEmpty(raw?.model)
    if (providerId || model) {
      models[role] = { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) }
    }
  }
  return {
    enabled: stored.enabled === true,
    startMode: HARNESS_EVOLUTION_START_MODES.includes(stored.startMode as HarnessEvolutionStartMode)
      ? (stored.startMode as HarnessEvolutionStartMode)
      : d.startMode,
    defaultMode: stored.defaultMode === "sequential" ? "sequential" : "parallel",
    defaultK: effectiveK(clampInt(stored.defaultK, 1, 4, d.defaultK), budget),
    budget,
    autoAdoptLowRisk: stored.autoAdoptLowRisk === true,
    useExperiences: stored.useExperiences !== false,
    editorChannel:
      stored.editorChannel === "agentic" || stored.editorChannel === "structured"
        ? stored.editorChannel
        : "auto",
    models,
    probeAllowedMcpServerIds: [
      ...new Set((stored.probeAllowedMcpServerIds ?? []).map(nonEmpty).filter(Boolean) as string[]),
    ].sort(),
    backgroundIntervalHours: clampInt(
      stored.backgroundIntervalHours,
      1,
      24 * 14,
      d.backgroundIntervalHours
    ),
    backgroundMaxRunsPerSweep: clampInt(
      stored.backgroundMaxRunsPerSweep,
      1,
      5,
      d.backgroundMaxRunsPerSweep
    ),
    failureOfferCooldownHours: clampInt(
      stored.failureOfferCooldownHours,
      0,
      24 * 7,
      d.failureOfferCooldownHours
    ),
    experienceCapPerAgent: clampInt(
      stored.experienceCapPerAgent,
      20,
      2_000,
      d.experienceCapPerAgent
    ),
  }
}

export function harnessEvolutionSettingsOf(
  settings: Pick<AppSettings, "harnessEvolution"> | null | undefined
): HarnessEvolutionSettings {
  return resolveHarnessEvolutionSettings(settings?.harnessEvolution)
}

const START_RANK: Record<HarnessEvolutionStartMode, number> = {
  disabled: 0,
  manual: 1,
  "failure-triggered": 2,
  background: 3,
}

/** May a run be started this way under these settings? */
export function isStartAllowed(
  settings: Pick<HarnessEvolutionSettings, "enabled" | "startMode">,
  trigger: "manual" | "failure-triggered" | "background"
): boolean {
  if (!settings.enabled) return false
  return START_RANK[settings.startMode] >= START_RANK[trigger]
}
