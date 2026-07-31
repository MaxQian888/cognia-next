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
// (re-verified v3.17), the MiniMax Token Plan FAQ, and the opencode-glm-quota
// plugin. Coding-plan descriptors use `request.useBaseUrlOrigin` so they resolve
// for the Anthropic relay presets (baseUrl `…/api/anthropic`) as well as the
// OpenAI-compatible chat presets — the quota path anchors at the host root. The
// engine supports three primitives that let the Chinese "Coding/Token Plan"
// quota providers join this catalog as pure data:
//   - count-based windows (`usedPath`/`totalPath`/`remainingPath`) for providers
//     that report request/token counts rather than a percentage (Kimi-coding),
//   - `invert` for providers that report a *remaining* percent (MiniMax), and
//   - `select` (discriminated-array element pick) so each window tier reads from
//     its own array entry — `data.limits[]` tagged by a numeric `unit` (Zhipu
//     GLM), or `model_remains[]` keyed by `model_name` (MiniMax).
// This is the deliberate trade for not shipping a JS sandbox: declarative path
// extraction + these primitives cover every Coding/Token Plan shape seen so far.
// Providers with genuinely no documented usage API (Qwen/通义, Baichuan/百川,
// 01.AI/零一万物) stay absent — users add those via the custom-source UI.
//
// Volcengine (火山方舟) Agent/Coding Plan quota is NOT a descriptor: its usage
// OpenAPI requires a Volcengine SigV4 signature over an access-key/secret pair
// (not the bearer coding-plan token our accounts store), which the bearer-only
// declarative engine can't express. It ships instead as a hand-written source
// (`sources/volcengine.ts`) backed by the SigV4-signing Rust command
// `subscription_volcengine_usage`; the AK/SK live in the preset's `x-cognia-volc-*`
// extraHeaders (stripped from the wire so the account-wide key never leaks).

import { descriptorToSource } from "./engine"

import type { LimitsSource, SourceDescriptor } from "@/types/subscription"

// StepFun (阶跃星辰) — balance at `https://api.stepfun.com/v1/accounts`, Bearer,
// `balance` (CNY). Built from the baseUrl ORIGIN so it resolves for both the
// OpenAI-compatible chat preset (`…/v1`) and the Anthropic relay preset
// (`…/step_plan`) — the balance path is fixed at the host root either way.
const stepfun: SourceDescriptor = {
  id: "stepfun",
  match: { providerKey: ["stepfun", "stepfun-anthropic"], baseUrlIncludes: "stepfun." },
  request: { useBaseUrlOrigin: true, path: "/v1/accounts" },
  extract: { kind: "balance", remainingPath: "balance", unit: "CNY", currency: "CNY" },
}

// Zhipu GLM (智谱 BigModel) Coding Plan — quota/limit endpoint. Uses the raw
// API key with NO `Bearer` scheme (the descriptor's Authorization header
// overrides the default bearer). `data.limits[]` is a discriminated array — one
// entry per window tier tagged by a numeric `unit` (3 = 5-hour, 6 = weekly),
// each carrying a utilization `percentage` and a unix-second `nextResetTime`.
// The `select` primitive picks the matching tier per window.
// Discriminator/auth verified against cc-switch `coding_plan.rs` (v3.16) and
// the opencode-glm-quota plugin (raw-key, no Bearer).
const glm: SourceDescriptor = {
  id: "glm",
  // Zhipu ships on two hosts: CN `open.bigmodel.cn` and international `api.z.ai`.
  // The quota path is host-root-anchored, so `useBaseUrlOrigin` lets ONE
  // descriptor serve both the chat preset and the `…/api/anthropic` relay preset
  // on either host — the origin (bigmodel.cn vs z.ai) is derived from the preset.
  match: {
    providerKey: ["glm", "glm-anthropic", "glm-anthropic-intl"],
    baseUrlIncludes: ["api.z.ai", "bigmodel.cn"],
  },
  request: {
    useBaseUrlOrigin: true,
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
  },
}

// MiniMax Token Plan — `/v1/token_plan/remains`, Bearer. (Supersedes the legacy
// `coding_plan/remains` path, which is a web-console route that rejects API-key
// callers with `1004 "cookie is missing"`.) `model_remains[]` is keyed by
// `model_name`; the `general` entry carries *remaining* percents per window, so
// the engine inverts them to a used%. Reset fields are best-effort (the public
// docs don't pin their names; a missing reset just renders the meter without a
// countdown). Endpoint + shape per the MiniMax Token Plan FAQ and cc-switch.
const minimax: SourceDescriptor = {
  id: "minimax",
  // "minimax" matches both CN `api.minimaxi.com` and intl `api.minimax.io`.
  // Origin-based so the `…/anthropic` relay preset resolves the same root path.
  match: {
    providerKey: ["minimax", "minimax-anthropic", "minimax-anthropic-intl"],
    baseUrlIncludes: "minimax",
  },
  request: { useBaseUrlOrigin: true, path: "/v1/token_plan/remains" },
  extract: {
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
  // Origin-based: the relay preset baseUrl is `https://api.kimi.com/coding/`, so
  // the usage path must anchor at the host root (not double the `/coding`).
  request: { useBaseUrlOrigin: true, path: "/coding/v1/usages" },
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
