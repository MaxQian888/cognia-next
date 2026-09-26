/**
 * Which saved external-agent config backs a preset-bound dispatch.
 *
 * A user can keep several configs of one preset ("Codex strict" and "Codex
 * lenient" are both `metadata.preset === "codex"`). An Agent Team teammate
 * (`TeammateConfig.runtime` + `externalAgentConfigId`) and a subagent
 * definition (`externalPresetId` + `externalAgentConfigId`) name a preset and,
 * optionally, one exact config. Every resolver that turns that pair into an
 * agent id goes through this module, so the team backing, the plugin/app
 * subagent dispatch and the `@member` turn route cannot disagree about which
 * config runs.
 *
 * # The rules
 *
 *  1. **An exact config id wins.** When a binding names one, that config and
 *     no other runs. If it is missing, disabled, or no longer built from the
 *     declared preset's family, the dispatch fails with an
 *     {@link ExternalAgentBindingError}. It never falls back to a sibling
 *     config: quietly running "Codex lenient" for a teammate the user pinned to
 *     "Codex strict" is the exact outcome the pin exists to rule out.
 *  2. **A bare preset picks deterministically.** Legacy bindings (and every
 *     binding that leaves the pin empty) take the best candidate built from
 *     exactly that preset, ordered by {@link compareExternalAgentCandidates}:
 *     enabled first, then connected, then the earliest `createdAt`, then the
 *     id. Object-insertion order used to decide, which made "which Codex did
 *     the teammate run on" depend on the order configs were loaded. A config
 *     that carries its own Cognia gateway binding is never chosen by preset
 *     alone: its account belongs to that config, not to every dispatch that
 *     happens to name the same executable.
 *
 * Pure: every input is passed in.
 */

import { externalAgentPresetIdOf } from "./preset-identity"

/**
 * Presets that are one runtime shipped as several executable surfaces. Codex is
 * the one: the native `codex app-server`, the `codex` shim and the ACP adapter
 * all answer as Codex, in that order of preference (the same preference
 * `resolvePreferredCodexExecutablePresetId` applies when adding one). Every
 * other preset is a family of one.
 */
export const CODEX_PRESET_FAMILY: readonly string[] = ["codex-app-server", "codex", "codex-acp"]

const PRESET_FAMILIES: ReadonlyArray<readonly string[]> = [CODEX_PRESET_FAMILY]

/** Every preset id that answers as the same runtime as `presetId`, itself included. */
export function presetFamilyOf(presetId: string): readonly string[] {
  return PRESET_FAMILIES.find((family) => family.includes(presetId)) ?? [presetId]
}

/**
 * Does a config built from `actualPresetId` satisfy a binding that declares
 * `declaredPresetId`? Same preset, or two surfaces of one runtime family: a
 * teammate declared as `codex` legitimately pins a config the user added
 * through the `codex-app-server` preset.
 */
export function presetSatisfiesDeclared(
  declaredPresetId: string,
  actualPresetId: string | undefined
): boolean {
  if (!actualPresetId) return false
  return presetFamilyOf(declaredPresetId).includes(actualPresetId)
}

/**
 * The facts selection reads about one config, whatever it was read from (a
 * stored config, a live manager instance, a runtime-catalog row).
 */
export interface ExternalAgentCandidate {
  id: string
  /** `metadata.preset` of the config, when it has one. */
  presetId: string | undefined
  enabled: boolean
  /** A live, connected process right now. */
  connected: boolean
  /** Creation time. Stored configs carry ISO strings, live ones `Date`s. */
  createdAt?: Date | string | number
  /** The config carries its own Cognia gateway model binding. */
  gatewayBound?: boolean
}

/** A config-shaped record as the store or the manager holds it. */
export interface ExternalAgentCandidateSource {
  id: string
  enabled: boolean
  metadata?: Record<string, unknown>
  createdAt?: Date | string | number
  cogniaModel?: unknown
}

/**
 * Project a stored config or a live instance's config into a candidate.
 *
 * `presetId` overrides the raw `metadata.preset` read. The manager-side callers
 * pass `isFromPreset(config)`, which answers only for presets that are still
 * registered, so a live agent whose contributing plugin went away is not
 * reused under that preset's name.
 */
export function toExternalAgentCandidate(
  config: ExternalAgentCandidateSource,
  connectionStatus?: string,
  presetId: string | null | undefined = externalAgentPresetIdOf(config)
): ExternalAgentCandidate {
  return {
    id: config.id,
    presetId: presetId ?? undefined,
    enabled: config.enabled !== false,
    connected: connectionStatus === "connected",
    ...(config.createdAt !== undefined ? { createdAt: config.createdAt } : {}),
    gatewayBound: Boolean(config.cogniaModel),
  }
}

function createdAtMs(value: ExternalAgentCandidate["createdAt"]): number {
  if (value === undefined) return Number.POSITIVE_INFINITY
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  // An unparseable timestamp sorts with the undated ones, after every dated one.
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/**
 * The documented preset-fallback order: enabled before disabled, connected
 * before not, earlier `createdAt` before later (undated last), then id.
 */
export function compareExternalAgentCandidates(
  a: ExternalAgentCandidate,
  b: ExternalAgentCandidate
): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
  if (a.connected !== b.connected) return a.connected ? -1 : 1
  const at = createdAtMs(a.createdAt)
  const bt = createdAtMs(b.createdAt)
  if (at !== bt) return at < bt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The candidate a bare preset binding runs on, or undefined when none exists
 * (the caller then spawns a fresh config from the preset).
 *
 * Exact preset match only: callers that want a family's preferred surface
 * (Codex) resolve the surface first, exactly as they did before this module.
 */
export function pickExternalAgentForPreset(
  candidates: readonly ExternalAgentCandidate[],
  presetId: string
): ExternalAgentCandidate | undefined {
  return candidates
    .filter((c) => c.presetId === presetId && !c.gatewayBound)
    .sort(compareExternalAgentCandidates)[0]
}

/**
 * Every config a picker may offer for pinning a binding that declares
 * `presetId`: the whole family, in the fallback order so the list reads the
 * same way selection does. Disabled configs stay listed so a pin that points at
 * one can still be shown and changed.
 */
export function listPinnableExternalAgents<T extends ExternalAgentCandidateSource>(
  configs: readonly T[],
  presetId: string
): T[] {
  return configs
    .map((config) => ({ config, candidate: toExternalAgentCandidate(config) }))
    .filter(({ candidate }) => presetSatisfiesDeclared(presetId, candidate.presetId))
    .sort((a, b) => compareExternalAgentCandidates(a.candidate, b.candidate))
    .map(({ config }) => config)
}

/** Why a pinned config cannot run. */
export type ExternalAgentBindingProblem =
  /** No config with the pinned id exists. */
  | "missing"
  /** The pinned config exists but is switched off. */
  | "disabled"
  /** The pinned config is no longer built from the declared preset's family. */
  | "preset-mismatch"
  /** The config passed the checks but could not be registered or started. */
  | "unavailable"

/** A pinned binding that cannot run. Never recovered by picking another config. */
export class ExternalAgentBindingError extends Error {
  constructor(
    readonly problem: ExternalAgentBindingProblem,
    readonly configId: string,
    readonly declaredPresetId: string,
    readonly actualPresetId?: string,
    readonly detail?: string
  ) {
    super(describeBindingProblem(problem, configId, declaredPresetId, actualPresetId, detail))
    this.name = "ExternalAgentBindingError"
  }
}

function describeBindingProblem(
  problem: ExternalAgentBindingProblem,
  configId: string,
  declaredPresetId: string,
  actualPresetId: string | undefined,
  detail: string | undefined
): string {
  const head = `External agent config "${configId}" (pinned for preset "${declaredPresetId}")`
  const tail = "it was NOT replaced by another config of that preset"
  switch (problem) {
    case "missing":
      return `${head} no longer exists; ${tail}. Pick another config or clear the pin.`
    case "disabled":
      return `${head} is disabled; ${tail}. Enable it, pick another config, or clear the pin.`
    case "preset-mismatch":
      return `${head} now runs preset "${actualPresetId ?? "none"}"; ${tail}. Pick another config or clear the pin.`
    case "unavailable":
      return `${head} could not be started${detail ? `: ${detail}` : ""}; ${tail}.`
  }
}

/** The verdict on a pinned config, without throwing. */
export type PinnedExternalAgentCheck =
  { ok: true } | { ok: false; problem: Exclude<ExternalAgentBindingProblem, "unavailable"> }

/** Check the pinned config (undefined when no config with that id exists). */
export function checkPinnedExternalAgent(
  candidate: ExternalAgentCandidate | undefined,
  declaredPresetId: string
): PinnedExternalAgentCheck {
  if (!candidate) return { ok: false, problem: "missing" }
  if (!candidate.enabled) return { ok: false, problem: "disabled" }
  if (!presetSatisfiesDeclared(declaredPresetId, candidate.presetId)) {
    return { ok: false, problem: "preset-mismatch" }
  }
  return { ok: true }
}

/** What a binding declares: a preset, and optionally one exact config of it. */
export interface ExternalAgentBinding {
  presetId: string
  /** Exact config id. Empty or absent means "any config of the preset". */
  configId?: string
}

export type ExternalAgentBindingResolution =
  /** Run exactly this config. */
  | { kind: "pinned"; agentId: string }
  /** Run this existing config of the preset, or spawn one when `agentId` is null. */
  | { kind: "preset"; agentId: string | null }

/** Normalize a stored pin: blank strings are "no pin". */
export function normalizePinnedConfigId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** The configs a binding is resolved against. */
export interface ExternalAgentBindingCandidates {
  /** Configs registered with the external-agent manager right now. */
  live: readonly ExternalAgentCandidate[]
  /**
   * The user's saved configs. A pin is looked up here first (the store is the
   * source of truth for `enabled` and the preset), then among `live` for
   * configs that only exist in the manager (plugin- or host-mounted agents).
   * The bare-preset fallback reads `live` only, as it always has: a saved
   * config that was never registered is not silently started by a preset.
   */
  stored?: readonly ExternalAgentCandidate[]
}

/**
 * Resolve a binding against the known configs. Throws
 * {@link ExternalAgentBindingError} when a pinned config cannot run.
 */
export function resolveExternalAgentBinding(
  binding: ExternalAgentBinding,
  candidates: ExternalAgentBindingCandidates
): ExternalAgentBindingResolution {
  const configId = normalizePinnedConfigId(binding.configId)
  if (configId) {
    const candidate =
      candidates.stored?.find((c) => c.id === configId) ??
      candidates.live.find((c) => c.id === configId)
    const check = checkPinnedExternalAgent(candidate, binding.presetId)
    if (!check.ok) {
      throw new ExternalAgentBindingError(
        check.problem,
        configId,
        binding.presetId,
        candidate?.presetId
      )
    }
    return { kind: "pinned", agentId: configId }
  }
  return {
    kind: "preset",
    agentId: pickExternalAgentForPreset(candidates.live, binding.presetId)?.id ?? null,
  }
}
