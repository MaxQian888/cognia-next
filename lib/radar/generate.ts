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
  const actions = (Array.isArray(o.actions) ? o.actions : [])
    .flatMap((action) => {
      if (typeof action === "string") return [{ text: action, evidence: [] as number[] }]
      if (!action || typeof action !== "object" || typeof action.text !== "string") return []
      const evidence = Array.isArray(action.sourceIndexes)
        ? [
            ...new Set<number>(
              action.sourceIndexes.filter(
                (index: unknown): index is number =>
                  typeof index === "number" &&
                  Number.isInteger(index) &&
                  index >= 0 &&
                  index < itemCount
              )
            ),
          ]
        : []
      return [{ text: action.text, evidence }]
    })
    .filter((action) => action.text.trim())
  const graveyard = Array.isArray(o.graveyard)
    ? (o.graveyard as unknown[])
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .filter(
          (g) =>
            typeof g.index === "number" &&
            Number.isInteger(g.index) &&
            g.index >= 0 &&
            g.index < itemCount &&
            typeof g.reason === "string"
        )
        .map((g) => ({ index: g.index as number, reason: g.reason as string }))
    : []
  const topicCloud = Array.isArray(o.topicCloud)
    ? (o.topicCloud as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
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
    actions: actions.map((action) => action.text),
    ...(actions.some((action) => action.evidence.length)
      ? { actionEvidence: actions.map((action) => action.evidence) }
      : {}),
    topicCloud,
  }
}

/**
 * Lifecycle hooks: NOT covered by settings.json lifecycle hooks (ADR-0040 scope
 * decision). This path builds a renderer-side `LlmClient` and calls the
 * provider directly, so it never reaches the sidecar where SDK-native hooks
 * are registered — wiring it up would mean a fourth hook rail, not a fire
 * site. A hook author sees this in the Hooks settings coverage list.
 */
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
