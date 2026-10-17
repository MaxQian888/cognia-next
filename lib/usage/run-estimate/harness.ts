/**
 * Harness keys for run estimates (ADR-0232).
 *
 * The same task costs very differently on Cognia's built-in lanes and on an
 * external CLI agent, so the estimate buckets by harness where it can. No run
 * record stores a harness, so a key is recovered from what each source does
 * carry: a squad teammate's `runtime`, a best-of-N candidate's provider marker
 * (`cognia:external-agent:<configId>` → the config's `metadata.preset`), an
 * imported transcript's `sourceId`. A run whose harness cannot be recovered
 * gets `null` and only joins the buckets that ignore harness.
 *
 * One external runtime can ship as several presets (Codex is the app server,
 * the shim and the ACP adapter), and the import adapters name it once more.
 * All of them must land in one key, or a person's Codex history would never
 * inform a Codex launch.
 */

import { presetFamilyOf } from "@/lib/ai/agent/external/config/agent-binding"
import {
  externalAgentIdFromProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session/session-models"

/** `builtin` is Cognia's own lanes; `ext:<runtime>` an external agent; `mixed` both or several. */
export type RunHarnessKey = "builtin" | "mixed" | `ext:${string}`

/** Looks up the preset an external-agent configuration was created from. */
export type ExternalPresetResolver = (configId: string) => string | undefined

/**
 * The key for an external runtime named by a preset id (`codex-app-server`),
 * a teammate runtime (`codex`) or an import source id (`claude-code`).
 */
export function externalHarnessKey(runtimeId: string): `ext:${string}` {
  const id = runtimeId.trim().toLowerCase()
  const family = presetFamilyOf(id)
  // A multi-surface runtime is named by its shortest member (`codex`).
  let name = family.length > 1 ? [...family].sort((a, b) => a.length - b.length)[0] : id
  name = name
    .replace(/-subagent$/, "")
    .replace(/-(?:rpc|acp|server|remote|v\d+-service)$/, "")
    .replace(/-(?:readonly|workspace)$/, "")
  return `ext:${name}`
}

/**
 * Harness of a run identified by its provider id. A Cognia provider is the
 * built-in lane; an external-agent marker resolves through its configuration's
 * preset, and is `null` when that configuration is gone or has no preset.
 */
export function harnessFromProvider(
  providerId: string | undefined | null,
  resolvePreset: ExternalPresetResolver
): RunHarnessKey | null {
  if (!isExternalAgentProviderId(providerId ?? undefined)) return "builtin"
  const configId = externalAgentIdFromProviderId(providerId ?? undefined)
  if (!configId) return null
  const preset = resolvePreset(configId)
  return preset ? externalHarnessKey(preset) : null
}

/**
 * Harness of a squad teammate from its recorded `runtime`. Absent and `claude`
 * are the built-in lane (`TeammateRuntime`); anything else names a preset.
 */
export function harnessFromTeammateRuntime(runtime: string | undefined): RunHarnessKey {
  return !runtime || runtime === "claude" ? "builtin" : externalHarnessKey(runtime)
}

/**
 * One key for a run made of several parts (teammates). An unknown part makes
 * the whole unknown, because a bucket keyed on the rest would claim a harness
 * the run did not purely use.
 */
export function combineHarness(keys: readonly (RunHarnessKey | null)[]): RunHarnessKey | null {
  if (keys.length === 0) return null
  if (keys.some((key) => key === null)) return null
  const distinct = new Set(keys)
  if (distinct.size === 1) return keys[0]
  return "mixed"
}
