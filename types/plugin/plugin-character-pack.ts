/**
 * Plugin Character Pack Definitions (ADR-0030).
 *
 * Plugins contributing the `character-pack` capability ship a bundle of
 * ready-to-use characters (system prompt + model defaults + skill / mcp /
 * native-tool wiring) through the manifest. The host registers each pack
 * into the `character-pack-registry` overlay on enable and unregisters on
 * disable — identical lifecycle to `skills` / `mcp-server-preset`.
 *
 * Two-tier identity:
 *   - `PluginCharacterPackDef.id` is unique within the plugin's manifest.
 *   - `PluginCharacterDef.localId` is unique within the pack.
 *   - The host derives the runtime character id at projection time:
 *       `cognia-pack:<pluginId>:<packId>:<localId>`
 *     This namespace is physically disjoint from the seeded `char_builtin_*`
 *     and user-generated `char_<ts>_<rand>` ids, so collisions are
 *     impossible. See ADR-0030.
 *
 * i18n: name / description are plain `string`. Plugins wanting localised
 * labels register their own translation bundle via
 * `lib/i18n/plugin-i18n-registry.ts:registerPluginI18n`; the host resolves
 * `plugin.<pluginId>.<key>` at render time. We deliberately do not embed
 * `{ ns, key }` here because no other manifest field follows that pattern.
 */

import type { Character, SendOptions } from "@cognia/agent-config-types"
import type { CharacterPlatformDefaults } from "@/types/connectors/binding"
import type { TTSProvider } from "@cognia/tts/types"
import type { PluginRuntimeProfile } from "./plugin"

/**
 * v2 — optional portable avatar image. Only `data:image/*` URLs are accepted;
 * the former `tauriPath` field was never consumed by the UI and was removed
 * so character packs cannot retain an unguarded filesystem path.
 */
export interface PluginCharacterAvatarImage {
  /** `data:image/*` URL — works in every shell. */
  webDataUrl: string
}

/**
 * v2 — personality / interaction metadata. Pure metadata for this round:
 * `resolveSendOptions` does NOT consume these yet. Display surfaces only.
 */
export interface PluginCharacterPersona {
  /** Free-form tone descriptor (e.g. "warm, encouraging"). */
  tone?: string
  /** Persona prose (e.g. "Former kindergarten teacher, prefers analogies."). */
  personality?: string
  /** Opening line shown when the user starts a new chat with the character. */
  openingMessage?: string
  /** Few-shot exemplar prompts surfaced as quick-action chips. */
  exemplarPrompts?: string[]
}

/**
 * v2 — voice profile. Rides the existing TTS orchestrator
 * (`lib/tts/tts-orchestrator.ts`). When the character is the active
 * speaker, `lib/plugin/character-pack/character-voice.ts:resolveCharacterVoice`
 * projects this into a `SpeechSettings` overlay; the caller passes that
 * overlay to `TTSOrchestrator.speak()` without mutating `AppSettings`.
 *
 * Unknown `provider` values degrade to "system" at SDK validate time and
 * are surfaced as a warning, not an error (ADR-0030 §B.6 spirit).
 */
export interface PluginCharacterVoiceProfile {
  provider: TTSProvider
  voiceId: string
  /** TTS rate multiplier. Inherits global `ttsRate` when undefined. */
  rate?: number
  pitch?: number
  volume?: number
}

/**
 * A single character contributed by a plugin pack.
 *
 * Field rules:
 * - Allowed: a strict subset of `Character` that makes sense for a portable
 *   bundle. Host-managed identity / lifecycle / Twin-binding fields are
 *   intentionally NOT allowed — they're filled in by the host at projection
 *   time (and on `duplicateCharacter` for user clones).
 * - `localId` replaces `id`; the runtime id is computed by the host.
 */
export interface PluginCharacterDef {
  /** Unique id within the pack. Host derives the runtime id from this. */
  localId: string
  /** Display name. Plain string — plugins do their own i18n. */
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  /** Required. The persona's system prompt. */
  systemPrompt: string

  // ---- Optional Character subset (mirrors `lib/claude/types.ts:Character`) ----
  model?: string
  providerId?: string
  permissionMode?: SendOptions["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  pluginSkillIds?: string[]
  workingDir?: string
  bareMode?: boolean
  debugMode?: boolean
  briefMode?: boolean
  enableComputerUse?: boolean
  enableBrowserTools?: boolean
  computerUseSettings?: Character["computerUseSettings"]
  sandboxEnabled?: boolean
  sandboxTier?: Character["sandboxTier"]
  platformDefaults?: CharacterPlatformDefaults
  a2uiEnabled?: boolean
  a2uiCatalogId?: string

  /**
   * Limit this character to specific host profiles. When set, the overlay
   * suppresses the character on profiles not listed (useful for packs that
   * mix desktop-only with cross-platform personas).
   */
  availableOnPlatforms?: PluginRuntimeProfile[]

  // ---- v2 fields (schemaVersion: 2) ----------------------------------------
  // All optional. v1 packs leave them undefined and the runtime falls back to
  // the v1 behaviour (`avatarEmoji + avatarColor` for display, AppSettings TTS
  // for voice, no persona panel).

  /** v2 — optional avatar image (Tauri path and/or web data URL). */
  avatarImage?: PluginCharacterAvatarImage
  /** v2 — personality / interaction metadata. Display-only this round. */
  persona?: PluginCharacterPersona
  /**
   * v2 — voice profile riding the existing TTS subsystem. Consumed via
   * `lib/plugin/character-pack/character-voice.ts:resolveCharacterVoice`.
   */
  voiceProfile?: PluginCharacterVoiceProfile
}

/**
 * A pack — one or more characters shipped together by a single plugin or
 * imported from a standalone `.cognia-pack.json` file.
 */
export interface PluginCharacterPackDef {
  /** Pack id; must be unique within the contributing plugin's manifest. */
  id: string
  /** Display name shown in the Settings → Characters → Packs subsection. */
  name: string
  description?: string
  /** Semver. Drives the user-clone "Update available" comparison. */
  version: string
  /** At least one character. SDK helper soft-caps at 50; see ADR-0030. */
  characters: PluginCharacterDef[]

  /**
   * Cross-capability dependencies. Validated at register time as warnings
   * (never blockers): a missing skill / mcp-preset / native-tool emits a
   * diagnostic and the affected character row in the picker carries a
   * "missing dependency" chip. See ADR-0030 §B.6.
   */
  requires?: {
    skills?: string[]
    pluginSkillIds?: string[]
    mcpServerPresets?: string[]
    nativeAnthropicTools?: string[]
    a2uiCatalogId?: string
  }

  /** Optional cosmetic. Used as a default for character avatars that omit one. */
  icon?: { emoji?: string; color?: string }
  /** Free-form tags surfaced in the Settings UI search. */
  tags?: string[]
}
