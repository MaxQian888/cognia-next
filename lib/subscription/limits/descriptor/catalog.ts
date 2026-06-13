// Built-in coding-plan / credit descriptor catalog.
//
// Each entry is a *grounded* provider (a real, documented endpoint — no
// fabricated URLs) expressed as data and turned into a `LimitsSource` by the
// engine. The catalog is consulted by `resolveLimitsSources` ahead of the
// hand-written sources, so a vault account whose preset points at one of these
// hosts lights up with zero per-provider code.
//
// Grounding: endpoints/field paths verified against CC Switch
// (`farion1231/cc-switch`) `services/balance.rs`. Providers whose quota needs
// array-filtering or cross-field arithmetic (MiniMax / Kimi-coding / Zhipu's
// `data.limits[*]`) are intentionally NOT here — a declarative path engine
// can't express them; users add those via the custom-source UI (which can carry
// the New-API `New-Api-User` header, raw-key auth, etc.). This boundary is the
// deliberate trade for not shipping a JS sandbox.

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

/** All built-in descriptors. */
export const BUILTIN_DESCRIPTORS: readonly SourceDescriptor[] = [stepfun]

/** Built-in descriptors projected into runnable sources (catalog tier). */
export const CATALOG_SOURCES: readonly LimitsSource[] = BUILTIN_DESCRIPTORS.map(descriptorToSource)
