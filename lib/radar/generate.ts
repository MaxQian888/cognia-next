/**
 * Radar report generation — thin wrapper around an injected `LlmClient`.
 * Mirrors `lib/ai/generation/title.ts`: the module owns the prompt + JSON
 * parsing/normalization, the client is injected so it unit-tests with a mock.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { RADAR_SYSTEM_PROMPT, buildRadarUserMessage } from "./prompts"
import type { RadarDataItem, RadarLlmOutput } from "@/types/radar"

export interface GenerateRadarArgs {
  items: readonly RadarDataItem[]
  locale?: string
}

/** Coerce arbitrary parsed JSON into a well-formed `RadarLlmOutput`. */
export function normalizeRadarOutput(raw: unknown, itemCount: number): RadarLlmOutput {
  const o = (raw ?? {}) as Record<string, unknown>
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  const graveyard = Array.isArray(o.graveyard)
    ? (o.graveyard as unknown[])
        .map((g) => g as Record<string, unknown>)
        .filter(
          (g) =>
            typeof g.index === "number" &&
            g.index >= 0 &&
            g.index < itemCount &&
            typeof g.reason === "string"
        )
        .map((g) => ({ index: g.index as number, reason: g.reason as string }))
    : []
  const topicCloud = Array.isArray(o.topicCloud)
    ? (o.topicCloud as unknown[])
        .map((t) => t as Record<string, unknown>)
        .filter((t) => typeof t.topic === "string")
        .map((t) => ({
          topic: t.topic as string,
          weight: typeof t.weight === "number" ? t.weight : 0,
        }))
    : []
  return {
    verdict: typeof o.verdict === "string" ? o.verdict : "",
    atAGlance: asStringArray(o.atAGlance),
    infoDiet: typeof o.infoDiet === "string" ? o.infoDiet : "",
    subconscious: typeof o.subconscious === "string" ? o.subconscious : "",
    graveyard,
    blindSpots: typeof o.blindSpots === "string" ? o.blindSpots : "",
    actions: asStringArray(o.actions),
    topicCloud,
  }
}

export async function generateRadarReport(
  client: LlmClient,
  { items, locale }: GenerateRadarArgs
): Promise<RadarLlmOutput> {
  const prompt = buildRadarUserMessage(items, locale)
  const raw = await client.complete(prompt, {
    system: RADAR_SYSTEM_PROMPT,
    temperature: 0.4,
    maxTokens: 2048,
  })
  const parsed = extractJson<unknown>(raw)
  return normalizeRadarOutput(parsed, items.length)
}
