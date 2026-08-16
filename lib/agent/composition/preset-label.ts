/**
 * Display name for a preset (ADR-0117).
 *
 * Both the composer chip and the settings-sheet picker have to answer "what is
 * this preset called", and both had their own copy of the same
 * translate-then-fall-back-to-the-record expression. Two copies of a naming rule
 * is how two surfaces end up calling the same mode different things.
 *
 * A preset that projects a built-in mode has a translated name under
 * `agentMode.modes.<id>.name`; a user's custom mode and a plugin's mode do not,
 * and their own `name` is already the user's words.
 */

import type { AgentPresetDefinitionV1 } from "@cognia/agent-config-types/agent-composition"

/**
 * `next-intl`'s namespaced `t`, narrowed to what this needs. `has` is optional
 * because older next-intl builds omit it; treat its absence as "no translation".
 */
export interface PresetNameTranslator {
  (key: string): string
  has?: (key: string) => boolean
}

export function presetDisplayName(
  preset: AgentPresetDefinitionV1,
  t: PresetNameTranslator
): string {
  const key = `${preset.id}.name`
  if (t.has?.(key)) {
    const translated = t(key)
    if (translated) return translated
  }
  return preset.name
}
