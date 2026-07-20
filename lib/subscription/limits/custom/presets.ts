// Preset templates for authoring custom limits sources.
//
// CCSwitch (`farion1231/cc-switch`) ships ready-made `UsageScriptModal` templates
// (New-API relay, generic balance, token/coding plans) so a user picks a shape
// and only fills the host + token. We mirror that here: each preset pre-fills a
// draft's `request` + `extract` (and the auth style via the `Authorization`
// header) while PRESERVING the user's `id`/`name`/`baseUrl`/`token`. The result is
// an ordinary `CustomLimitsSource`, run by the same descriptor engine the built-in
// catalog uses — no new runtime path.
//
// Grounding: New-API field/quota-unit from one-api/new-api (`/api/user/self`,
// quota unit 500000 = $1); GitHub Copilot from CCSwitch `subscription.rs`
// (`/copilot_internal/user`, `quota_snapshots.premium_interactions`,
// `quota_reset_date`). Coding-plan-count is a generic scaffold for count-style
// quotas (MiniMax/Kimi-coding shape) the user points at their endpoint.

import type { CustomLimitsSource, DescriptorExtract } from "@/types/subscription"

/** A named template that fills a custom-source draft's request + extract. */
export interface CustomSourcePreset {
  /** Stable id, also the Select option value. */
  id: string
  /** i18n key under `subscription.customSources.presets.*` for the option label. */
  labelKey: string
  /** Return the draft with this preset's request + extract applied. */
  apply(src: CustomLimitsSource): CustomLimitsSource
}

/** New-API / one-api relay quota unit: 500000 internal units = $1 USD. */
export const NEW_API_QUOTA_SCALE = 1 / 500_000

function withTemplate(
  src: CustomLimitsSource,
  request: CustomLimitsSource["request"],
  extract: DescriptorExtract
): CustomLimitsSource {
  return { ...src, request, extract }
}

// "Custom (blank)" — leave the draft untouched so picking it never wipes work.
const custom: CustomSourcePreset = {
  id: "custom",
  labelKey: "subscription.customSources.presets.custom",
  apply: (src) => src,
}

// New-API / one-api relay (packycode / aigocode / aicodemirror / 88code …):
// `GET /api/user/self` with a bearer token + a `New-Api-User` id header. The user
// quota is reported in internal units (500000 = $1) → scaled to USD.
const newApi: CustomSourcePreset = {
  id: "new-api",
  labelKey: "subscription.customSources.presets.newApi",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/api/user/self", headers: { "New-Api-User": "" } },
      {
        kind: "balance",
        remainingPath: "data.quota",
        usedPath: "data.used_quota",
        scale: NEW_API_QUOTA_SCALE,
        unit: "USD",
        currency: "USD",
      }
    ),
}

// Generic OpenAI-compatible credit balance: `GET /user/balance` → `data.balance`.
const genericBalance: CustomSourcePreset = {
  id: "generic-balance",
  labelKey: "subscription.customSources.presets.genericBalance",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/user/balance" },
      {
        kind: "balance",
        remainingPath: "data.balance",
        totalPath: "data.total_balance",
        unit: "USD",
        currency: "USD",
      }
    ),
}

// Count-style coding plan scaffold (MiniMax / Kimi-coding shape): a single window
// whose utilization is derived from used/total counts. The user edits the paths
// to match their provider.
const codingPlanCount: CustomSourcePreset = {
  id: "coding-plan-count",
  labelKey: "subscription.customSources.presets.codingPlanCount",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/coding_plan/usage" },
      {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPath: "data.used",
            totalPath: "data.total",
            resetAtPath: "data.reset_at",
            resetUnit: "unix",
          },
        ],
      }
    ),
}

// GitHub Copilot: `GET /copilot_internal/user` on api.github.com with a GitHub
// token (`Authorization: token …`). `premium_interactions.percent_remaining` is
// remaining-percent → inverted to used-percent; `quota_reset_date` is an ISO date.
const githubCopilot: CustomSourcePreset = {
  id: "github-copilot",
  labelKey: "subscription.customSources.presets.githubCopilot",
  apply: (src) =>
    withTemplate(
      src,
      {
        path: "/copilot_internal/user",
        headers: {
          Authorization: "token {{token}}",
          "Editor-Version": "vscode/1.110.1",
          "X-GitHub-Api-Version": "2025-10-01",
        },
      },
      {
        kind: "window",
        windows: [
          {
            id: "premium",
            labelKey: "subscription.limits.meter.session",
            usedPctPath: "quota_snapshots.premium_interactions.percent_remaining",
            invert: true,
            resetAtPath: "quota_reset_date",
            resetUnit: "iso",
          },
        ],
      }
    ),
}

const kimiCoding: CustomSourcePreset = {
  id: "kimi-coding",
  labelKey: "subscription.customSources.presets.kimiCoding",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/coding/v1/usages" },
      {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            remainingPath: "usage.remaining",
            totalPath: "usage.limit",
            resetAtPath: "usage.resetTime",
            resetUnit: "unix",
          },
        ],
      }
    ),
}

const glmCoding: CustomSourcePreset = {
  id: "glm-coding",
  labelKey: "subscription.customSources.presets.glmCoding",
  apply: (src) =>
    withTemplate(
      src,
      {
        path: "/api/monitor/usage/quota/limit",
        headers: { Authorization: "{{token}}" },
      },
      {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPctPath: "percentage",
            resetAtPath: "nextResetTime",
            resetUnit: "unix",
            select: { arrayPath: "data.limits", by: "unit", equals: 3 },
          },
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            usedPctPath: "percentage",
            resetAtPath: "nextResetTime",
            resetUnit: "unix",
            select: { arrayPath: "data.limits", by: "unit", equals: 6 },
          },
        ],
      }
    ),
}

const minimaxTokenPlan: CustomSourcePreset = {
  id: "minimax-token-plan",
  labelKey: "subscription.customSources.presets.minimaxTokenPlan",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/v1/token_plan/remains" },
      {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPctPath: "current_interval_remaining_percent",
            invert: true,
            resetAtPath: "end_time",
            resetUnit: "unix",
            select: { arrayPath: "model_remains", by: "model_name", equals: "general" },
          },
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            usedPctPath: "current_weekly_remaining_percent",
            invert: true,
            resetAtPath: "weekly_end_time",
            resetUnit: "unix",
            select: { arrayPath: "model_remains", by: "model_name", equals: "general" },
          },
        ],
      }
    ),
}

const zenmux: CustomSourcePreset = {
  id: "zenmux",
  labelKey: "subscription.customSources.presets.zenmux",
  apply: (src) =>
    withTemplate(
      src,
      { path: "/" },
      {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPctPath: "data.quota_5_hour.usage_percentage",
            usedPctScale: 100,
            resetAtPath: "data.quota_5_hour.resets_at",
            resetUnit: "iso",
          },
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            usedPctPath: "data.quota_7_day.usage_percentage",
            usedPctScale: 100,
            resetAtPath: "data.quota_7_day.resets_at",
            resetUnit: "iso",
          },
        ],
      }
    ),
}

/** All authoring presets, "Custom (blank)" first. */
export const CUSTOM_SOURCE_PRESETS: readonly CustomSourcePreset[] = [
  custom,
  newApi,
  genericBalance,
  codingPlanCount,
  githubCopilot,
  kimiCoding,
  glmCoding,
  minimaxTokenPlan,
  zenmux,
]

/** Look up a preset by id (defaults to the no-op `custom` preset). */
export function presetById(id: string): CustomSourcePreset {
  return CUSTOM_SOURCE_PRESETS.find((p) => p.id === id) ?? custom
}
