/**
 * Session presets as Prompt Center resources (ADR-0236 §5.1).
 *
 * A preset fills a session's configuration, its prompt included, when it is
 * applied; it is not an extra prompt layer. The preset row stays the authority:
 * a custom preset is saved through `updatePreset`, a seeded built-in is never
 * edited (its owner rejects it) and is changed by duplicating it into a custom
 * copy. "Use by default" is a separate binding (`setDefaultPreset`), never a
 * side effect of editing the text.
 */

import {
  duplicatePreset,
  getPreset,
  isBuiltInPreset,
  listPresets,
  setDefaultPreset,
  updatePreset,
} from "@/lib/db/prompt-presets"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "preset" || !id) throw new Error(`not a preset resource: ${key}`)
  return id
}

export const presetPromptAdapter: OwnerPromptAdapter = {
  source: "preset",

  async list() {
    const presets = await listPresets()
    return presets.map((preset): PromptResourceSummary => ({
      key: resourceKey("preset", preset.id),
      source: "preset",
      kind: "role",
      operation: "legacy-replace",
      name: preset.name,
      builtIn: isBuiltInPreset(preset),
      modified: false,
      edit: isBuiltInPreset(preset) ? "custom-copy" : "source",
      ownerSection: "presets",
      ...(preset.category ? { detail: preset.category } : {}),
    }))
  },

  async read(key) {
    const preset = await getPreset(idOf(key))
    if (!preset) return undefined
    return {
      key,
      text: preset.content,
      ...(isBuiltInPreset(preset) ? { readOnlyReason: "built-in" as const } : {}),
    }
  },

  async save(key, text) {
    const id = idOf(key)
    const preset = await getPreset(id)
    if (!preset) throw new Error(`Preset ${id} not found`)
    if (isBuiltInPreset(preset))
      throw new Error(`Preset ${id} is built in; edit a copy of it instead.`)
    await updatePreset(id, { content: text })
    return (await presetPromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const copy = await duplicatePreset(idOf(key))
    await updatePreset(copy.id, {
      content: text,
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    })
    return resourceKey("preset", copy.id)
  },

  async makeDefault(key) {
    await setDefaultPreset(idOf(key))
  },
}
