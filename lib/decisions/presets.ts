/**
 * Remote decisions endpoints (ADR-0194). All speak the TypeSafe decisions
 * protocol — `POST {model, state, questions}` → `{answers}` — at one of two
 * paths: OpenRouter's `api/alpha/decisions`, and `/v1/systemone` on TypeSafe
 * and the gateways that proxy it. URLs and default models are the ones
 * jev-chat-jarvis ships and verified (`core/Prefs.kt` `judgeEndpoint()`).
 */

import type { DecisionHttpPresetId, DecisionSettings } from "@/types/decisions"

export interface DecisionHttpPreset {
  id: DecisionHttpPresetId
  /** Full POST URL; `null` for `custom` (the user supplies it). */
  url: string | null
  defaultModel: string | null
  /** Where the user gets a key — shown next to the key field. */
  keyUrl: string | null
}

export const DECISION_HTTP_PRESETS: Readonly<Record<DecisionHttpPresetId, DecisionHttpPreset>> = {
  openrouter: {
    id: "openrouter",
    url: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: "typesafe/jev-1.13",
    keyUrl: "https://openrouter.ai/keys",
  },
  bocha: {
    id: "bocha",
    url: "https://jev.bocha.cn/v1/systemone",
    defaultModel: "bocha-jev-v1",
    keyUrl: "https://jev.bocha.cn",
  },
  typesafe: {
    id: "typesafe",
    url: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-latest",
    keyUrl: "https://typesafe.ai",
  },
  vercel: {
    id: "vercel",
    url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    defaultModel: "typesafe-ai/jev",
    keyUrl: "https://vercel.com/ai-gateway",
  },
  zen: {
    id: "zen",
    url: "https://opencode.ai/zen/v1/systemone",
    defaultModel: "jev-1.13",
    keyUrl: "https://opencode.ai/zen",
  },
  custom: { id: "custom", url: null, defaultModel: null, keyUrl: null },
}

export type ResolvedDecisionEndpoint =
  | { ok: true; preset: DecisionHttpPresetId; url: string; model: string }
  | { ok: false; reason: "no_preset" | "no_url" | "bad_url" | "no_model" }

/** URL + model the built-in remote provider will call, from settings alone. */
export function resolveDecisionEndpoint(
  http: DecisionSettings["http"] | undefined
): ResolvedDecisionEndpoint {
  if (!http || !(http.preset in DECISION_HTTP_PRESETS)) return { ok: false, reason: "no_preset" }
  const preset = DECISION_HTTP_PRESETS[http.preset]
  const url = http.url?.trim() || preset.url
  if (!url) return { ok: false, reason: "no_url" }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: "bad_url" }
  }
  // Plain http only for a loopback endpoint (a local gateway); a key must
  // never travel in clear text to a remote host.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return { ok: false, reason: "bad_url" }
  }
  const model = http.model?.trim() || preset.defaultModel
  if (!model) return { ok: false, reason: "no_model" }
  return { ok: true, preset: preset.id, url: parsed.toString(), model }
}

/** OpenRouter asks callers for attribution headers; other hosts get none. */
export function attributionHeaders(url: string): Record<string, string> {
  try {
    if (new URL(url).hostname.endsWith("openrouter.ai")) {
      return { "HTTP-Referer": "https://cognia.cn", "X-Title": "Cognia" }
    }
  } catch {
    // resolveDecisionEndpoint already rejected malformed URLs.
  }
  return {}
}
