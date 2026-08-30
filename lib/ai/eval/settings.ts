/**
 * Read side of {@link EvalSettings}: merge the user's `AppSettings.evalSettings`
 * over {@link DEFAULT_EVAL_SETTINGS} and repair anything stale (out-of-range k,
 * scorer ids that no longer exist). Every eval consumer resolves through here so
 * the defaults live in exactly one place.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalSettings } from "@/types/eval/settings"
import { DEFAULT_EVAL_SETTINGS, MAX_STORED_OUTPUT_CHARS } from "@/types/eval/settings"
import { sanitizeScorerIds } from "@cognia/eval-core/scorers/catalog"

const MIN_K = 1
const MAX_K = 10

function clampK(k: number): number {
  if (!Number.isFinite(k)) return DEFAULT_EVAL_SETTINGS.defaultK
  return Math.min(MAX_K, Math.max(MIN_K, Math.round(k)))
}

function clampStoredOutput(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_EVAL_SETTINGS.maxStoredOutputChars
  return Math.min(MAX_STORED_OUTPUT_CHARS, Math.max(0, Math.round(n)))
}

/** Merge + sanitize the persisted eval settings. Always returns a full object. */
export function resolveEvalSettings(appSettings: AppSettings | null | undefined): EvalSettings {
  const raw = appSettings?.evalSettings
  const merged: EvalSettings = { ...DEFAULT_EVAL_SETTINGS, ...(raw ?? {}) }
  return {
    ...merged,
    defaultK: clampK(merged.defaultK),
    defaultScorerIds: sanitizeScorerIds(merged.defaultScorerIds ?? []),
    maxStoredOutputChars: clampStoredOutput(merged.maxStoredOutputChars),
  }
}

export const EVAL_K_RANGE = { min: MIN_K, max: MAX_K } as const
