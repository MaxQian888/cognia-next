/**
 * The LLM classifier absorbs the difficulty judge (ADR-0188 D18, B5).
 *
 * Legacy Auto's second-opinion judge had its own settings: a router model
 * (`autoRouting.routerModel`), a timeout (`autoRouting.judge.timeoutMs`) and a
 * verdict cache (`autoRouting.enableCache`, `autoRouting.cacheTTL`). The first
 * time the user enables the LLM classifier, what they chose there carries over,
 * and what was there is snapshotted in `llmClassifier.judgeMigration` — the
 * same shape of first-enable migration as the legacy Auto one
 * (`legacy-auto-migration.ts`).
 *
 * Carried over, and only into a classifier field the user has not already set:
 *
 * - a configured router model, as the classifier's model;
 * - a judge timeout ABOVE the classifier's default, since the user allowed the
 *   judge that long (a shorter one is not: the classifier answers a structured
 *   object, not one word, and D18 sizes it at 1500 ms);
 * - a cache the user switched off (TTL 0), or a TTL they changed from the
 *   legacy default.
 *
 * `autoRouting` is never modified. With the classifier off again, the judge runs
 * on its own settings exactly as before; enabling again does not migrate twice.
 *
 * Pure functions over plain settings; the classifier section saves the results.
 */

import {
  DEFAULT_AUTO_ROUTER_SETTINGS,
  type AutoRoutingSettings,
} from "@cognia/provider-types/auto-router"
import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  normalizeRouterFusionSettings,
  type JudgeMigrationSnapshot,
  type LlmClassifierSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

const CLASSIFIER_DEFAULTS = DEFAULT_ROUTER_FUSION_SETTINGS.llmClassifier
const MAX_TIMEOUT_MS = 60_000
const MAX_CACHE_TTL_SECONDS = 86_400

function judgeSettingsOf(autoRouting: AutoRoutingSettings | undefined): unknown {
  if (!autoRouting) return null
  return structuredClone({
    judge: autoRouting.judge ?? null,
    routerModel: autoRouting.routerModel ?? null,
    enableCache: autoRouting.enableCache ?? null,
    cacheTTL: autoRouting.cacheTTL ?? null,
  })
}

/**
 * The settings after the user switches the classifier on. Migrates the judge's
 * settings only the first time (no snapshot yet); a later enable just flips the
 * switch and leaves every field as the user left it.
 */
export function enableLlmClassifier(
  current: RouterFusionSettings,
  autoRouting: AutoRoutingSettings | undefined,
  now: number
): RouterFusionSettings {
  const classifier = current.llmClassifier
  if (classifier.judgeMigration) {
    return normalizeRouterFusionSettings({
      ...current,
      llmClassifier: { ...classifier, enabled: true },
    })
  }

  const next: LlmClassifierSettings = { ...structuredClone(classifier), enabled: true }
  const carried: JudgeMigrationSnapshot["carried"] = []

  const routerModel = autoRouting?.routerModel
  if (
    (!classifier.routerProviderId || !classifier.routerModelId) &&
    typeof routerModel?.provider === "string" &&
    routerModel.provider.length > 0 &&
    typeof routerModel.model === "string" &&
    routerModel.model.length > 0
  ) {
    next.routerProviderId = routerModel.provider
    next.routerModelId = routerModel.model
    carried.push("routerModel")
  }

  const judgeTimeout = autoRouting?.judge?.timeoutMs
  if (
    classifier.timeoutMs === CLASSIFIER_DEFAULTS.timeoutMs &&
    typeof judgeTimeout === "number" &&
    Number.isSafeInteger(judgeTimeout) &&
    judgeTimeout > CLASSIFIER_DEFAULTS.timeoutMs
  ) {
    next.timeoutMs = Math.min(judgeTimeout, MAX_TIMEOUT_MS)
    carried.push("timeoutMs")
  }

  if (classifier.cacheTtlSeconds === CLASSIFIER_DEFAULTS.cacheTtlSeconds && autoRouting) {
    const ttl = autoRouting.cacheTTL
    if (autoRouting.enableCache === false) {
      next.cacheTtlSeconds = 0
      carried.push("cacheTtlSeconds")
    } else if (
      typeof ttl === "number" &&
      Number.isSafeInteger(ttl) &&
      ttl >= 1 &&
      ttl <= MAX_CACHE_TTL_SECONDS &&
      ttl !== DEFAULT_AUTO_ROUTER_SETTINGS.cacheTTL
    ) {
      next.cacheTtlSeconds = ttl
      carried.push("cacheTtlSeconds")
    }
  }

  next.judgeMigration = { capturedAt: now, judge: judgeSettingsOf(autoRouting), carried }
  return normalizeRouterFusionSettings({ ...current, llmClassifier: next })
}

/** Switch the classifier off. Its settings and the migration record stay. */
export function disableLlmClassifier(current: RouterFusionSettings): RouterFusionSettings {
  return normalizeRouterFusionSettings({
    ...current,
    llmClassifier: { ...current.llmClassifier, enabled: false },
  })
}

/**
 * What the first enable carried over from the difficulty judge, for the
 * section's notice. Empty when nothing was carried or the classifier is off.
 */
export function carriedFromJudge(
  settings: RouterFusionSettings
): JudgeMigrationSnapshot["carried"] {
  const classifier = settings.llmClassifier
  if (!classifier.enabled || !classifier.judgeMigration) return []
  return [...classifier.judgeMigration.carried]
}
