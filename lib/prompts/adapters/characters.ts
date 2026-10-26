/**
 * Characters as Prompt Center resources (ADR-0236 §5.1).
 *
 * A character's `systemPrompt` is the base a turn starts from (the
 * `legacy-replace` operation of §2.3). The character row stays its only
 * authority: a user agent is saved in place through `updateCharacter`, and a
 * shipped one (a seeded built-in, a plugin-pack overlay, the support agent) is
 * never edited. Its custom version is an agent variant (ADR-0199) that owns
 * only its prompt and keeps following the base for everything else.
 */

import type { Character } from "@cognia/agent-config-types"
import {
  createCharacterVariant,
  listCharacterVariants,
  listResolvedCharacters,
  resolveCharacterById,
  updateCharacter,
} from "@/lib/db/characters"
import { isOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type OwnerPromptDocument,
  type PromptResourceSummary,
} from "../resources"

/** The support agent refuses every edit (`updateCharacter`). */
const IMMUTABLE_CHARACTER_IDS = new Set(["char_builtin_support"])

function readOnlyReason(character: Character): OwnerPromptDocument["readOnlyReason"] {
  if (IMMUTABLE_CHARACTER_IDS.has(character.id)) return "immutable"
  if (isOverlayCharacterId(character.id)) return "plugin"
  if (character.isBuiltIn) return "built-in"
  return undefined
}

function ownsPrompt(character: Character): boolean {
  return Boolean(character.variant?.ownFields.includes("systemPrompt"))
}

/** The variant of `baseId` whose prompt a previous custom edit set, if any. */
async function customVariantOf(baseId: string): Promise<Character | undefined> {
  const variants = await listCharacterVariants(baseId)
  return variants
    .filter(ownsPrompt)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]
}

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "character" || !id) throw new Error(`not a character resource: ${key}`)
  return id
}

export const characterPromptAdapter: OwnerPromptAdapter = {
  source: "character",

  async list() {
    const characters = await listResolvedCharacters()
    return characters.map((character): PromptResourceSummary => ({
      key: resourceKey("character", character.id),
      source: "character",
      kind: "role",
      operation: "legacy-replace",
      name: character.name,
      builtIn: readOnlyReason(character) !== undefined,
      modified: ownsPrompt(character),
      edit: readOnlyReason(character) ? "custom-copy" : "source",
      ownerSection: "characters",
      ...(character.description ? { detail: character.description } : {}),
    }))
  },

  async read(key) {
    const character = await resolveCharacterById(idOf(key))
    if (!character) return undefined
    const base = character.variant
      ? await resolveCharacterById(character.variant.baseId)
      : undefined
    const reason = readOnlyReason(character)
    const custom = reason ? await customVariantOf(character.id) : undefined
    return {
      key,
      text: character.systemPrompt ?? "",
      ...(base ? { baseText: base.systemPrompt ?? "" } : {}),
      ...(reason ? { readOnlyReason: reason } : {}),
      ...(custom ? { customKey: resourceKey("character", custom.id) } : {}),
    }
  },

  async save(key, text) {
    const id = idOf(key)
    const character = await resolveCharacterById(id)
    if (!character) throw new Error(`Character ${id} not found`)
    if (readOnlyReason(character)) {
      throw new Error(`Character ${id} is shipped; edit a variant of it instead.`)
    }
    // A variant owns the field only while it differs from its base, so
    // typing the base's text back makes it follow the base again.
    await updateCharacter(id, { systemPrompt: text })
    return (await characterPromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const id = idOf(key)
    const character = await resolveCharacterById(id)
    if (!character) throw new Error(`Character ${id} not found`)
    const existing = await customVariantOf(id)
    const variant =
      existing ?? (await createCharacterVariant(id, options.name?.trim() || character.name))
    await updateCharacter(variant.id, { systemPrompt: text })
    return resourceKey("character", variant.id)
  },

  async reset(key) {
    const id = idOf(key)
    const character = await resolveCharacterById(id)
    if (!character?.variant) throw new Error(`Character ${id} is not a variant`)
    const base = await resolveCharacterById(character.variant.baseId)
    if (!base) throw new Error(`The base of agent ${id} is missing`)
    // Only the prompt goes back to the base; the variant's other edits stay.
    await updateCharacter(id, { systemPrompt: base.systemPrompt })
  },
}
