/**
 * Standalone `.cognia-pack.json` file schema (ADR-0030).
 *
 * Two-step versioning:
 *  - `schemaVersion` is the FILE format version. v1 ships an unsigned
 *    or Ed25519-signed pack. Bumping `schemaVersion` (e.g., to v2 for a
 *    different signature scheme) is a host-side concern — the
 *    `PluginCharacterPackDef` payload itself is independently versioned
 *    via `PluginCharacterPackDef.version` (semver, surfaced in the
 *    "Update available" UI).
 *  - `pack.version` is the SEMANTIC version of the pack content.
 *
 * The file format is intentionally minimal: a wrapper object so we can
 * add fields (signature, manifest, source-tracking metadata) without
 * breaking older readers — and a schema version so we can refuse files
 * written for a future format we don't understand.
 */

import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import { PLUGIN_CHARACTER_PACK_SOFT_LIMIT } from "@cognia/plugin-sdk"

/**
 * Current file-format version emitted by `serializeLocalPackFile`. Bumped to
 * `2` to admit the new optional fields on each character (`avatarImage`,
 * `persona`, `voiceProfile`). v1 files remain readable — see
 * {@link SUPPORTED_SCHEMA_VERSIONS}.
 */
export const CHARACTER_PACK_FILE_SCHEMA_VERSION = 2 as const

/**
 * Every file-format version this build can parse. We deliberately keep v1
 * around so existing `.cognia-pack.json` files on disk and the user's
 * round-trip workflow (export then re-import an older file) keep working
 * without forcing the author to re-export. New writes always emit
 * {@link CHARACTER_PACK_FILE_SCHEMA_VERSION}.
 */
export const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([1, 2])

/** Union of every parseable schema version. Mirrors {@link SUPPORTED_SCHEMA_VERSIONS}. */
export type CharacterPackFileSchemaVersion = 1 | 2

/**
 * Optional detached Ed25519 signature over the JSON-encoded pack payload.
 * Matches `lib/plugin/wasm/signature-verifier.ts` shape — V1 only stores
 * it for forward compatibility; the local-pack-store does NOT yet verify
 * signatures (verification is a follow-up that wires through the WASM
 * verifier). Unsigned files are accepted today; once signing is enabled
 * end-to-end, the importer can flip a `requireSignature` toggle to
 * reject unsigned imports.
 */
export interface LocalCharacterPackSignature {
  algo: "ed25519"
  pubKey: string
  sig: string
}

export interface LocalCharacterPackFile {
  /** Any version in {@link SUPPORTED_SCHEMA_VERSIONS}. New writes use {@link CHARACTER_PACK_FILE_SCHEMA_VERSION}. */
  schemaVersion: CharacterPackFileSchemaVersion
  pack: PluginCharacterPackDef
  signature?: LocalCharacterPackSignature
}

export type ParseResult = { ok: true; file: LocalCharacterPackFile } | { ok: false; error: string }

/**
 * Validate-and-narrow an arbitrary JSON value into a `LocalCharacterPackFile`.
 *
 * Rules enforced (see ADR-0030 risks list):
 * - Top-level shape must be `{ schemaVersion: 1, pack: { ... } }`.
 * - `schemaVersion` must equal the host's current schema constant. A
 *   higher number means the file was written by a future version of the
 *   app; we refuse it loudly rather than risk dropping unknown fields.
 * - Pack-level required fields: `id` (non-empty), `name` (non-empty),
 *   `version` (non-empty), `characters` (non-empty array up to
 *   `PLUGIN_CHARACTER_PACK_SOFT_LIMIT`).
 * - Every character must carry a non-empty `localId` and `systemPrompt`,
 *   and `localId` must be unique within the pack.
 * - Signature, when present, must declare `algo: "ed25519"` and string
 *   `pubKey` / `sig` fields. We don't verify the signature here — that's
 *   the local-pack-store's job — but we reject malformed shapes.
 */
export function parseLocalPackFile(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Expected a JSON object" }
  }
  const obj = raw as Record<string, unknown>
  const schemaVersion = obj.schemaVersion
  if (typeof schemaVersion !== "number") {
    return { ok: false, error: "Missing or non-numeric schemaVersion" }
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
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
  const packErr = validatePackShape(obj.pack as Record<string, unknown>)
  if (packErr) return { ok: false, error: packErr }

  if (obj.signature !== undefined) {
    const sigErr = validateSignatureShape(obj.signature)
    if (sigErr) return { ok: false, error: sigErr }
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
  if (pack.characters.length > PLUGIN_CHARACTER_PACK_SOFT_LIMIT) {
    return `Pack declares ${pack.characters.length} characters; soft limit is ${PLUGIN_CHARACTER_PACK_SOFT_LIMIT}.`
  }
  const seen = new Set<string>()
  for (const [i, raw] of pack.characters.entries()) {
    if (!raw || typeof raw !== "object") {
      return `characters[${i}] is not an object`
    }
    const ch = raw as Record<string, unknown>
    if (typeof ch.localId !== "string" || !ch.localId.trim()) {
      return `characters[${i}] missing string \`localId\``
    }
    if (typeof ch.systemPrompt !== "string" || !ch.systemPrompt.trim()) {
      return `characters[${i}] missing string \`systemPrompt\``
    }
    if (typeof ch.name !== "string" || !ch.name.trim()) {
      return `characters[${i}] missing string \`name\``
    }
    if (typeof ch.avatarColor !== "string" || !ch.avatarColor.trim()) {
      return `characters[${i}] missing string \`avatarColor\``
    }
    if (seen.has(ch.localId)) {
      return `Duplicate localId "${ch.localId}" within pack`
    }
    seen.add(ch.localId)

    // v2 optional fields. All checks no-op on v1 packs because the fields
    // are absent. We never reject for unknown TTS providers here — that
    // belongs in `defineCharacterPack` (warn-not-block) so file imports
    // from a slightly older host don't hard-fail.
    const v2Err = validateV2CharacterFields(ch, i)
    if (v2Err) return v2Err
  }
  return null
}

function validateV2CharacterFields(ch: Record<string, unknown>, i: number): string | null {
  if (ch.avatarImage !== undefined) {
    if (!ch.avatarImage || typeof ch.avatarImage !== "object") {
      return `characters[${i}].avatarImage must be an object`
    }
    const ai = ch.avatarImage as Record<string, unknown>
    const tp = ai.tauriPath
    const wd = ai.webDataUrl
    if (tp !== undefined && (typeof tp !== "string" || !tp.trim())) {
      return `characters[${i}].avatarImage.tauriPath must be a non-empty string when set`
    }
    if (wd !== undefined && (typeof wd !== "string" || !wd.trim())) {
      return `characters[${i}].avatarImage.webDataUrl must be a non-empty string when set`
    }
    if (tp === undefined && wd === undefined) {
      return `characters[${i}].avatarImage must declare at least one of tauriPath / webDataUrl`
    }
  }
  if (ch.persona !== undefined) {
    if (!ch.persona || typeof ch.persona !== "object") {
      return `characters[${i}].persona must be an object`
    }
    const persona = ch.persona as Record<string, unknown>
    for (const key of ["tone", "personality", "openingMessage"] as const) {
      const v = persona[key]
      if (v !== undefined && (typeof v !== "string" || !v.trim())) {
        return `characters[${i}].persona.${key} must be a non-empty string when set`
      }
    }
    const ex = persona.exemplarPrompts
    if (ex !== undefined) {
      if (!Array.isArray(ex)) {
        return `characters[${i}].persona.exemplarPrompts must be an array when set`
      }
      for (const [j, prompt] of ex.entries()) {
        if (typeof prompt !== "string" || !prompt.trim()) {
          return `characters[${i}].persona.exemplarPrompts[${j}] must be a non-empty string`
        }
      }
    }
  }
  if (ch.voiceProfile !== undefined) {
    if (!ch.voiceProfile || typeof ch.voiceProfile !== "object") {
      return `characters[${i}].voiceProfile must be an object`
    }
    const vp = ch.voiceProfile as Record<string, unknown>
    if (typeof vp.provider !== "string" || !vp.provider.trim()) {
      return `characters[${i}].voiceProfile.provider must be a non-empty string`
    }
    if (typeof vp.voiceId !== "string" || !vp.voiceId.trim()) {
      return `characters[${i}].voiceProfile.voiceId must be a non-empty string`
    }
    for (const key of ["rate", "pitch", "volume"] as const) {
      const v = vp[key]
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
        return `characters[${i}].voiceProfile.${key} must be a finite number when set`
      }
    }
  }
  return null
}

function validateSignatureShape(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Signature must be an object"
  const sig = raw as Record<string, unknown>
  if (sig.algo !== "ed25519") return `Unsupported signature algo "${sig.algo}"`
  if (typeof sig.pubKey !== "string" || !sig.pubKey.trim()) {
    return "Signature missing string `pubKey`"
  }
  if (typeof sig.sig !== "string" || !sig.sig.trim()) {
    return "Signature missing string `sig`"
  }
  return null
}

/**
 * Serialize a pack into the canonical `.cognia-pack.json` file format.
 * Currently always v1; takes an optional signature for callers that
 * sign out-of-band (host-side helpers; not implemented in V1).
 */
export function serializeLocalPackFile(
  pack: PluginCharacterPackDef,
  signature?: LocalCharacterPackSignature
): string {
  const file: LocalCharacterPackFile = {
    schemaVersion: CHARACTER_PACK_FILE_SCHEMA_VERSION,
    pack,
    ...(signature ? { signature } : {}),
  }
  // 2-space indent + trailing newline keeps diffs reviewable when packs
  // are checked into git for share / fork workflows.
  return JSON.stringify(file, null, 2) + "\n"
}
