/**
 * The one mapping from a `UsageSurface` to its i18n leaf under
 * `subscription.usage.surface.*`.
 *
 * The ids are kebab-case (`agent-team`, `web-search`) because they are storage
 * values; the message keys are camelCase because that is the convention of the
 * catalogue. Both call sites build the key at runtime, which `lint:i18n` cannot
 * see — so the table is also the thing the co-located test walks to prove every
 * declared surface has a label in both locales. Before it, only four of the
 * fifteen surfaces had one, and the Usage tab got away with it purely because
 * its filter row is hard-limited to three of them.
 *
 * Pure and dependency-free so the CLI can share it.
 */

import type { UsageSurface } from "@/lib/db/session-usage"

/** Surface id → message-catalogue leaf. Exhaustive over `UsageSurface`. */
const SURFACE_LABEL_KEYS: Record<UsageSurface, string> = {
  chat: "chat",
  workflow: "workflow",
  "agent-team": "agentTeam",
  connector: "connector",
  goal: "goal",
  embedding: "embedding",
  twin: "twin",
  memory: "memory",
  eval: "eval",
  subagent: "subagent",
  plugin: "plugin",
  ocr: "ocr",
  tts: "tts",
  "web-search": "webSearch",
  imported: "imported",
}

/**
 * Message-catalogue leaf for one surface. Unknown ids (a row written by a newer
 * build) fall back to the raw id: the caller checks `has()` before translating,
 * so an unmapped surface degrades to its id instead of throwing.
 */
export function surfaceLabelKey(surface: string): string {
  return SURFACE_LABEL_KEYS[surface as UsageSurface] ?? surface
}
