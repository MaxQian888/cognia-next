// Built-in coding-plan / credit descriptor catalog.
//
// Each entry is a *grounded* provider (a real, documented endpoint — no
// fabricated URLs) expressed as data and turned into a `LimitsSource` by the
// engine. The catalog is consulted by `resolveLimitsSources` ahead of the
// hand-written sources, so a vault account whose preset points at one of these
// hosts lights up with zero per-provider code.
//
// Grounding: endpoints/field paths verified against CC Switch
// (`farion1231/cc-switch`) `services/balance.rs` + `services/coding_plan.rs`
// (v3.16). The engine now supports two primitives that let the Chinese "Coding
// Plan" quota providers join this catalog as pure data:
//   - count-based windows (`usedPath`/`totalPath`/`remainingPath`) for providers
//     that report request/token counts rather than a percentage (MiniMax,
//     Kimi-coding), and
//   - `select` (discriminated-array element pick) so each window tier reads from
//     its own `data.limits[]` entry tagged by `TOKENS_LIMIT` (Zhipu GLM).
// This is the deliberate trade for not shipping a JS sandbox: declarative path
// extraction + these two primitives cover every Coding Plan shape seen so far.
// Providers with genuinely no documented usage API (Qwen/通义, Baichuan/百川,
// 01.AI/零一万物) stay absent — users add those via the custom-source UI.

import { descriptorToSource } from "./engine"

import type { LimitsSource, SourceDescriptor } from "@/types/subscription"

// StepFun (阶跃星辰) — balance at `https://api.stepfun.com/v1/accounts`, Bearer,
// `balance` (CNY). The path is relative to the account's OpenAI-compatible
// baseUrl, which ends in `/v1` by convention → `/accounts`.
const stepfun: SourceDescriptor = {
  id: "stepfun",
  match: { providerKey: "stepfun", baseUrlIncludes: "stepfun." },
  request: { path: "/accounts" },
  extract: { kind: "balance", remainingPath: "balance", unit: "CNY", currency: "CNY" },
}

// Zhipu GLM (智谱 BigModel) Coding Plan — quota/limit endpoint. Uses the raw
// API key with NO `Bearer` scheme (the descriptor's Authorization header
// overrides the default bearer). `data.limits[]` is a discriminated array — one
// entry per window tier tagged `TOKENS_LIMIT: "five_hour" | "weekly"`, each
// carrying a utilization `percentage` and a unix-second `nextResetTime`. The
// `select` primitive picks the matching tier per window.
const glm: SourceDescriptor = {
  id: "glm",
  match: { providerKey: "glm", baseUrlIncludes: "api.z.ai" },
  request: {
    path: "/api/monitor/usage/quota/limit",
    headers: { Authorization: "{{token}}" },
  },
  extract: {
    kind: "window",
    windows: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        usedPctPath: "percentage",
        resetAtPath: "nextResetTime",
        resetUnit: "unix",
        select: { arrayPath: "data.limits", by: "TOKENS_LIMIT", equals: "five_hour" },
      },
      {
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        usedPctPath: "percentage",
        resetAtPath: "nextResetTime",
        resetUnit: "unix",
        select: { arrayPath: "data.limits", by: "TOKENS_LIMIT", equals: "weekly" },
      },
    ],
  },
}

// MiniMax Coding Plan — `coding_plan/remains`, Bearer. `model_remains[0]`
// carries interval + weekly count pairs plus their reset times. Counts, not a
// percentage → the engine derives `used/total` utilization per window.
const minimax: SourceDescriptor = {
  id: "minimax",
  match: { providerKey: "minimax", baseUrlIncludes: "minimax" },
  request: { path: "/v1/api/openplatform/coding_plan/remains" },
  extract: {
    kind: "window",
    windows: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        usedPath: "model_remains.0.current_interval_usage_count",
        totalPath: "model_remains.0.current_interval_total_count",
        resetAtPath: "model_remains.0.end_time",
        resetUnit: "unix",
      },
      {
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        usedPath: "model_remains.0.current_weekly_usage_count",
        totalPath: "model_remains.0.current_weekly_total_count",
        resetAtPath: "model_remains.0.weekly_end_time",
        resetUnit: "unix",
      },
    ],
  },
}

// Kimi Coding Plan (Moonshot 订阅) — `coding/v1/usages`, Bearer. The top-level
// `usage` object is the 5h aggregate `{limit, remaining, resetTime}`; we derive
// utilization from `1 - remaining/total`. Host `api.kimi.com` is distinct from
// the Moonshot inference balance (`api.moonshot.cn`, handled by the moonshot
// balance adapter), so the two never collide.
const kimiCoding: SourceDescriptor = {
  id: "kimi-coding",
  match: { providerKey: "kimi-coding", baseUrlIncludes: "api.kimi.com" },
  request: { path: "/coding/v1/usages" },
  extract: {
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
  },
}

/** All built-in descriptors. */
export const BUILTIN_DESCRIPTORS: readonly SourceDescriptor[] = [stepfun, glm, minimax, kimiCoding]

/** Built-in descriptors projected into runnable sources (catalog tier). */
export const CATALOG_SOURCES: readonly LimitsSource[] = BUILTIN_DESCRIPTORS.map(descriptorToSource)
