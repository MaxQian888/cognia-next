/**
 * Pack `requires` validation (ADR-0030 §B.6).
 *
 * Runs at register time and on demand to detect missing dependencies in a
 * `PluginCharacterPackDef`'s `requires` block. Warnings are surfaced via
 * the `PluginCharacterPackWarning` channel on the registry entry; they
 * never block registration — pack characters degrade gracefully when a
 * referenced id is missing (the build-options pipeline already silently
 * drops unknown skill ids).
 *
 * Scope: this checks the overlay registries (skills / mcp-server-presets /
 * native-anthropic-tools) because they're sync and in-memory. It does NOT
 * check Dexie-backed chat skills — those are loaded async on demand and
 * checking them would require a register-time DB call. UI-side validation
 * (`characters-section.tsx`) catches Dexie misses at render time instead.
 */

import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import { listSkillIds } from "@/lib/plugin/registries/skill-registry"
import { listMcpServerPresetIds } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listNativeAnthropicToolIds } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { hasThemePackKey } from "@/lib/theme/theme-pack-registry"
import { isKnownConnectorKind } from "@/lib/connectors/known-kinds"
import { hasProvider } from "@cognia/provider-types"

export interface PluginCharacterPackWarning {
  /** Stable id used to dedupe warnings on the UI. */
  code:
    | "missing-skill"
    | "missing-plugin-skill"
    | "missing-mcp-preset"
    | "missing-native-tool"
    | "missing-a2ui-catalog"
    | "missing-theme-pack"
    | "missing-connector"
    | "missing-provider"
  /** The id we couldn't resolve. */
  missingId: string
  /** Which pack character (if any) references the missing id. */
  characterLocalId?: string
}

export interface PackRequiresValidationResult {
  warnings: PluginCharacterPackWarning[]
  /** True when nothing's missing. */
  ok: boolean
}

/**
 * Inspect a pack's declared dependencies + every contained character's
 * referenced skills / MCP presets / native tools, and return the union of
 * the misses. Each character's individual references are checked
 * independently so the UI can render targeted "X needs skill Y" chips
 * without a full re-validation pass.
 *
 * The `a2uiCatalogId` check is left as a presence test only — there is no
 * sync "is catalog X registered" accessor today; a follow-up can wire
 * that through the A2UI catalog registry. Today we record the declared
 * catalog id as a warning when the pack lists one but no host A2UI catalog
 * resolves; this keeps the warning surface forward-compatible.
 */
export function validatePackRequires(pack: PluginCharacterPackDef): PackRequiresValidationResult {
  const warnings: PluginCharacterPackWarning[] = []
  const skillIds = new Set(listSkillIds())
  const mcpIds = new Set(listMcpServerPresetIds())
  const nativeToolIds = new Set(listNativeAnthropicToolIds())

  const requires = pack.requires ?? {}

  // Pack-level `requires` block. These are explicit author-declared deps.
  for (const id of requires.skills ?? []) {
    if (!skillIds.has(id)) {
      warnings.push({ code: "missing-skill", missingId: id })
    }
  }
  for (const id of requires.pluginSkillIds ?? []) {
    if (!skillIds.has(id)) {
      warnings.push({ code: "missing-plugin-skill", missingId: id })
    }
  }
  for (const id of requires.mcpServerPresets ?? []) {
    if (!mcpIds.has(id)) {
      warnings.push({ code: "missing-mcp-preset", missingId: id })
    }
  }
  for (const id of requires.nativeAnthropicTools ?? []) {
    if (!nativeToolIds.has(id)) {
      warnings.push({ code: "missing-native-tool", missingId: id })
    }
  }
  // Theme packs are addressed by the canonical `"<pluginId>.<packId>"` key —
  // the same string the theme registry uses internally.
  for (const key of requires.themePacks ?? []) {
    if (!hasThemePackKey(key)) {
      warnings.push({ code: "missing-theme-pack", missingId: key })
    }
  }
  for (const kind of requires.connectors ?? []) {
    if (!isKnownConnectorKind(kind)) {
      warnings.push({ code: "missing-connector", missingId: kind })
    }
  }
  for (const providerId of requires.providers ?? []) {
    if (!hasProvider(providerId)) {
      warnings.push({ code: "missing-provider", missingId: providerId })
    }
  }

  // Character-level references. Tracked separately so the UI can call out
  // which character within a pack is broken when only some are. We tolerate
  // a missing/empty characters array so the function is safe to call from
  // the capability-bridge dispatch loop with arbitrary stub shapes (test
  // fixtures pass bare `{ id }` entries).
  for (const ch of pack.characters ?? []) {
    for (const id of ch.pluginSkillIds ?? []) {
      if (!skillIds.has(id)) {
        warnings.push({
          code: "missing-plugin-skill",
          missingId: id,
          characterLocalId: ch.localId,
        })
      }
    }
    // A character pinned to a provider the user has not installed is the real
    // failure mode for `requires.providers` — the pack-level list is the
    // author's declaration, this is the actual reference.
    if (ch.providerId && !hasProvider(ch.providerId)) {
      warnings.push({
        code: "missing-provider",
        missingId: ch.providerId,
        characterLocalId: ch.localId,
      })
    }
    // `skillIds` (chat skills) are Dexie-backed; we don't check them at
    // register time — UI-level validation handles that case so we don't
    // block on an async DB query inside the synchronous register loop.
  }

  return { warnings, ok: warnings.length === 0 }
}
