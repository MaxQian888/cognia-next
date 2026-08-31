/** Portable authoring contracts for Cognia character packs. */

import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"

export {
  defineCharacterPack,
  PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES,
  PLUGIN_CHARACTER_PACK_SOFT_LIMIT,
} from "../define/define-character-pack"

export type { PluginCharacterDef, PluginCharacterPackDef }
export type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"

export const CHARACTER_PACK_FILE_SCHEMA_VERSION = 2 as const
export const SUPPORTED_CHARACTER_PACK_SCHEMA_VERSIONS = new Set<number>([1, 2])
export const SUPPORTED_SCHEMA_VERSIONS = SUPPORTED_CHARACTER_PACK_SCHEMA_VERSIONS

export type CharacterPackFileSchemaVersion = 1 | 2

export interface LocalCharacterPackSignature {
  algo: "ed25519"
  pubKey: string
  sig: string
}

export interface LocalCharacterPackFile {
  schemaVersion: CharacterPackFileSchemaVersion
  pack: PluginCharacterPackDef
  signature?: LocalCharacterPackSignature
}

export type CharacterPackParseResult =
  { ok: true; file: LocalCharacterPackFile } | { ok: false; error: string }

export function buildOverlayCharacterId(
  pluginId: string | undefined,
  packId: string,
  localId: string
): string {
  return `cognia-pack:${pluginId ?? ""}:${packId}:${localId}`
}

export function isOverlayCharacterId(id: string): boolean {
  return id.startsWith("cognia-pack:")
}

export function parseLocalPackFile(raw: unknown): CharacterPackParseResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Expected a JSON object" }
  }
  const obj = raw as Record<string, unknown>
  const schemaVersion = obj.schemaVersion
  if (typeof schemaVersion !== "number") {
    return { ok: false, error: "Missing or non-numeric schemaVersion" }
  }
  if (!SUPPORTED_CHARACTER_PACK_SCHEMA_VERSIONS.has(schemaVersion)) {
    return {
      ok: false,
      error:
        schemaVersion > CHARACTER_PACK_FILE_SCHEMA_VERSION
          ? `Unsupported schemaVersion ${schemaVersion} (this build understands up to ${CHARACTER_PACK_FILE_SCHEMA_VERSION}). Upgrade Cognia to import this pack.`
          : `Outdated schemaVersion ${schemaVersion} — re-export the pack from a newer build.`,
    }
  }
  if (!obj.pack || typeof obj.pack !== "object") {
    return { ok: false, error: "Missing or non-object `pack` field" }
  }
  const packError = validatePackShape(obj.pack as Record<string, unknown>)
  if (packError) return { ok: false, error: packError }

  if (obj.signature !== undefined) {
    const signatureError = validateSignatureShape(obj.signature)
    if (signatureError) return { ok: false, error: signatureError }
  }

  return {
    ok: true,
    file: {
      schemaVersion: schemaVersion as CharacterPackFileSchemaVersion,
      pack: obj.pack as unknown as PluginCharacterPackDef,
      signature: obj.signature as LocalCharacterPackSignature | undefined,
    },
  }
}

function validatePackShape(pack: Record<string, unknown>): string | null {
  if (typeof pack.id !== "string" || !pack.id.trim()) return "Pack missing string `id`"
  if (typeof pack.name !== "string" || !pack.name.trim()) return "Pack missing string `name`"
  if (typeof pack.version !== "string" || !pack.version.trim()) {
    return "Pack missing string `version`"
  }
  if (!Array.isArray(pack.characters) || pack.characters.length === 0) {
    return "Pack must declare at least one character in `characters`"
  }
  if (pack.characters.length > 50) {
    return `Pack declares ${pack.characters.length} characters; soft limit is 50.`
  }

  const seen = new Set<string>()
  for (const [index, rawCharacter] of pack.characters.entries()) {
    if (!rawCharacter || typeof rawCharacter !== "object") {
      return `characters[${index}] is not an object`
    }
    const character = rawCharacter as Record<string, unknown>
    if (typeof character.localId !== "string" || !character.localId.trim()) {
      return `characters[${index}] missing string \`localId\``
    }
    if (typeof character.systemPrompt !== "string" || !character.systemPrompt.trim()) {
      return `characters[${index}] missing string \`systemPrompt\``
    }
    if (typeof character.name !== "string" || !character.name.trim()) {
      return `characters[${index}] missing string \`name\``
    }
    if (typeof character.avatarColor !== "string" || !character.avatarColor.trim()) {
      return `characters[${index}] missing string \`avatarColor\``
    }
    if (seen.has(character.localId)) {
      return `Duplicate localId "${character.localId}" within pack`
    }
    seen.add(character.localId)
    const v2Error = validateV2CharacterFields(character, index)
    if (v2Error) return v2Error
  }
  return null
}

function validateV2CharacterFields(
  character: Record<string, unknown>,
  index: number
): string | null {
  if (character.avatarImage !== undefined) {
    if (!character.avatarImage || typeof character.avatarImage !== "object") {
      return `characters[${index}].avatarImage must be an object`
    }
    const avatarImage = character.avatarImage as Record<string, unknown>
    if ("tauriPath" in avatarImage) {
      return `characters[${index}].avatarImage.tauriPath is no longer supported; use webDataUrl`
    }
    if (typeof avatarImage.webDataUrl !== "string" || !avatarImage.webDataUrl.trim()) {
      return `characters[${index}].avatarImage.webDataUrl must be a non-empty string`
    }
  }

  if (character.persona !== undefined) {
    if (!character.persona || typeof character.persona !== "object") {
      return `characters[${index}].persona must be an object`
    }
    const persona = character.persona as Record<string, unknown>
    for (const key of ["tone", "personality", "openingMessage"] as const) {
      const value = persona[key]
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        return `characters[${index}].persona.${key} must be a non-empty string when set`
      }
    }
    if (persona.exemplarPrompts !== undefined) {
      if (!Array.isArray(persona.exemplarPrompts)) {
        return `characters[${index}].persona.exemplarPrompts must be an array when set`
      }
      for (const [promptIndex, prompt] of persona.exemplarPrompts.entries()) {
        if (typeof prompt !== "string" || !prompt.trim()) {
          return `characters[${index}].persona.exemplarPrompts[${promptIndex}] must be a non-empty string`
        }
      }
    }
  }

  if (character.voiceProfile !== undefined) {
    if (!character.voiceProfile || typeof character.voiceProfile !== "object") {
      return `characters[${index}].voiceProfile must be an object`
    }
    const voiceProfile = character.voiceProfile as Record<string, unknown>
    if (typeof voiceProfile.provider !== "string" || !voiceProfile.provider.trim()) {
      return `characters[${index}].voiceProfile.provider must be a non-empty string`
    }
    if (typeof voiceProfile.voiceId !== "string" || !voiceProfile.voiceId.trim()) {
      return `characters[${index}].voiceProfile.voiceId must be a non-empty string`
    }
    for (const key of ["rate", "pitch", "volume"] as const) {
      const value = voiceProfile[key]
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        return `characters[${index}].voiceProfile.${key} must be a finite number when set`
      }
    }
  }
  return null
}

function validateSignatureShape(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Signature must be an object"
  const signature = raw as Record<string, unknown>
  if (signature.algo !== "ed25519") return `Unsupported signature algo "${signature.algo}"`
  if (typeof signature.pubKey !== "string" || !signature.pubKey.trim()) {
    return "Signature missing string `pubKey`"
  }
  if (typeof signature.sig !== "string" || !signature.sig.trim()) {
    return "Signature missing string `sig`"
  }
  return null
}

export function serializeLocalPackFile(
  pack: PluginCharacterPackDef,
  signature?: LocalCharacterPackSignature
): string {
  const file: LocalCharacterPackFile = {
    schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
    pack,
    ...(signature ? { signature } : {}),
  }
  return JSON.stringify(file, null, 2) + "\n"
}
