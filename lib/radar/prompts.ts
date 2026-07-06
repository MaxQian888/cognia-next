/**
 * Prompt construction for the Attention Radar. Pure — no LLM client — so it is
 * unit-testable and the generator stays a thin wrapper.
 */

import type { RadarDataItem } from "@/types/radar"

export const RADAR_SYSTEM_PROMPT =
  "You are a private knowledge analyst. Given a list of the user's recently " +
  "saved/learned items, produce a sharp, opinionated diagnosis of their " +
  "information diet. Rules: address the user as 'you'; be specific and cite " +
  "concrete items by their 0-based index; avoid obvious/generic statements — " +
  "surface surprising connections, unconscious interests, and blind spots; " +
  "back every claim with a number or an item reference. Write in the same " +
  "language as the items. Return ONLY a single JSON object, no prose, matching " +
  "exactly this shape:\n" +
  "{\n" +
  '  "verdict": string,            // one-line opinionated summary\n' +
  '  "atAGlance": string[],        // 2-3 top highlights\n' +
  '  "infoDiet": string,           // sources / depth / dominant topics\n' +
  '  "subconscious": string,       // interests you may not realize, with evidence\n' +
  '  "graveyard": [{ "index": number, "reason": string }],  // forgotten high-value items to revisit\n' +
  '  "blindSpots": string,         // neglected angles or contradictions\n' +
  '  "actions": string[],          // 3 concrete next actions\n' +
  '  "topicCloud": [{ "topic": string, "weight": number }]  // weight in 0..1\n' +
  "}"

/** Format one item line: `[i] (source, ISO-date) text…`. */
function formatItem(item: RadarDataItem, index: number): string {
  const date = new Date(item.at).toISOString().slice(0, 10)
  const text = item.text.replace(/\s+/g, " ").trim().slice(0, 400)
  return `[${index}] (${item.source}, ${date}) ${text}`
}

export function buildRadarUserMessage(items: readonly RadarDataItem[], locale?: string): string {
  const localeHint = locale ? `UI locale: ${locale}\n` : ""
  const lines = items.map((item, i) => formatItem(item, i)).join("\n")
  return (
    `${localeHint}Here are ${items.length} recent items (index in brackets):\n\n` +
    `${lines}\n\n` +
    "Analyze the user's information diet and return the JSON object described in the system prompt."
  )
}
