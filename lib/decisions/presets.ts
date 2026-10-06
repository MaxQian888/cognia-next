/**
 * Remote decision adapters (ADR-0194). Native Jev presets retain full POST
 * URLs; language-model and AI Gateway SDK presets use API base URLs.
 */

import type {
  DecisionHttpPresetId,
  DecisionProbabilityKind,
  DecisionSettings,
} from "@/types/decisions"

export type DecisionSdkAdapter =
  "typesafe" | "legacy" | "openai" | "anthropic" | "google" | "gateway"

export interface DecisionHttpPreset {
  adapter: DecisionSdkAdapter
  id: DecisionHttpPresetId
  /** Full POST URL for native/legacy; API base URL for SDK adapters. */
  url: string | null
  defaultModel: string | null
  /** Where the user gets a key — shown next to the key field. */
  keyUrl: string | null
}

export const DECISION_HTTP_PRESETS: Readonly<Record<DecisionHttpPresetId, DecisionHttpPreset>> = {
  openrouter: {
    id: "openrouter",
    adapter: "typesafe",
    url: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: "typesafe/jev-1.13",
    keyUrl: "https://openrouter.ai/keys",
  },
  bocha: {
    id: "bocha",
    adapter: "typesafe",
    url: "https://jev.bocha.cn/v1/systemone",
    defaultModel: "bocha-jev-v1",
    keyUrl: "https://jev.bocha.cn",
  },
  typesafe: {
    id: "typesafe",
    adapter: "typesafe",
    url: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-latest",
    keyUrl: "https://typesafe.ai",
  },
  vercel: {
    id: "vercel",
    adapter: "typesafe",
    url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    defaultModel: "typesafe-ai/jev",
    keyUrl: "https://vercel.com/ai-gateway",
  },
  zen: {
    id: "zen",
    adapter: "typesafe",
    url: "https://opencode.ai/zen/v1/systemone",
    defaultModel: "jev-1.13",
    keyUrl: "https://opencode.ai/zen",
  },
  custom: { adapter: "legacy", id: "custom", url: null, defaultModel: null, keyUrl: null },
  openai: {
    id: "openai",
    adapter: "openai",
    url: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    adapter: "anthropic",
    url: "https://api.anthropic.com/v1",
    defaultModel: "claude-haiku-4-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  google: {
    id: "google",
    adapter: "google",
    url: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  gateway: {
    id: "gateway",
    adapter: "gateway",
    url: "https://ai-gateway.vercel.sh/v4/ai",
    defaultModel: "openai/gpt-5-mini",
    keyUrl: "https://vercel.com/ai-gateway",
  },
}

/** Protocol semantics, not a claim that an arbitrary model is calibrated. */
export function getDecisionProbabilityKind(
  http: DecisionSettings["http"]
): DecisionProbabilityKind {
  const adapter = http && DECISION_HTTP_PRESETS[http.preset]?.adapter
  if (adapter === "typesafe") return "native"
  if (adapter === "openai" || adapter === "anthropic" || adapter === "google") return "estimated"
  // A Gateway model may itself be native or LLM-backed; do not infer from its name.
  return "unknown"
}

/** Only the existing, measured Jev preset configuration inherits copilot validation. */
export function isDecisionCopilotValidated(http: DecisionSettings["http"]): boolean {
  const endpoint = resolveDecisionEndpoint(http)
  if (!endpoint.ok) return false
  const preset = DECISION_HTTP_PRESETS[endpoint.preset]
  return (
    preset.adapter === "typesafe" &&
    endpoint.url === preset.url &&
    endpoint.model === preset.defaultModel
  )
}

export type ResolvedDecisionEndpoint =
  | { ok: true; preset: DecisionHttpPresetId; url: string; model: string }
  | { ok: false; reason: "no_preset" | "no_url" | "bad_url" | "no_model" }

/** URL + model the built-in remote provider will call, from settings alone. */
export function resolveDecisionEndpoint(
  http: DecisionSettings["http"] | undefined
): ResolvedDecisionEndpoint {
  if (!http || !Object.hasOwn(DECISION_HTTP_PRESETS, http.preset))
    return { ok: false, reason: "no_preset" }
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
  if (parsed.username || parsed.password || parsed.hash) return { ok: false, reason: "bad_url" }
  const model = http.model?.trim() || preset.defaultModel
  if (!model) return { ok: false, reason: "no_model" }
  return { ok: true, preset: preset.id, url: parsed.toString(), model }
}

/** OpenRouter asks callers for attribution headers; other hosts get none. */
export function attributionHeaders(url: string): Record<string, string> {
  try {
    const hostname = new URL(url).hostname
    if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) {
      return { "HTTP-Referer": "https://cognia.cn", "X-Title": "Cognia" }
    }
  } catch {
    // resolveDecisionEndpoint already rejected malformed URLs.
  }
  return {}
}
