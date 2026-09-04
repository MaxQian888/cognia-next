"use client"

/**
 * Character pack updates.
 *
 * A pack has no version line of its own: it ships inside a plugin, so its
 * update IS that plugin's update. This adapter therefore never fetches
 * anything. It reports packs whose parent plugin has already moved ahead of
 * the installed character rows, and its action opens the existing three-way
 * diff so user-edited fields are preserved rather than overwritten.
 *
 * A locally authored `.cognia-pack.json` is not a remote source and is never
 * reported here. Treating it as one would show a permanent phantom update on
 * every pack the user wrote themselves.
 */

import type { UpdateCandidate } from "@cognia/agent-config-types"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"

export interface CharacterPackRow {
  /** Character row id, which is what the diff dialog opens on. */
  characterId: string
  displayName: string
  /** Plugin that ships this pack. */
  pluginId: string
  /** Pack version currently applied to the character row. */
  appliedVersion: string
  /** Pack version the installed plugin now carries. */
  availableVersion: string
  /** True when the pack came from a local file rather than a plugin install. */
  local?: boolean
  /** Number of pack-managed fields the user has edited. */
  userEditedFields?: number
}

export interface CharacterPackAdapterDeps {
  listPacks?: () => Promise<CharacterPackRow[]>
  /** Open the existing three-way diff dialog for one character row. */
  openDiff?: (characterId: string) => Promise<void>
  isSupported?: () => boolean
}

export function createCharacterPackAdapter(deps: CharacterPackAdapterDeps = {}): UpdateAdapter {
  return {
    kind: "character-pack",
    executor: "character-pack-runtime",
    isSupported: () => deps.isSupported?.() ?? Boolean(deps.listPacks),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const rows = (await deps.listPacks?.()) ?? []
      return rows
        .filter((row) => !row.local && row.availableVersion !== row.appliedVersion)
        .map((row) => ({
          assetId: row.characterId,
          kind: "character-pack" as const,
          executor: "character-pack-runtime" as const,
          currentVersion: row.appliedVersion,
          targetVersion: row.availableVersion,
          channel: context.channel,
          criticality: "routine" as const,
          source: "plugin-host" as const,
          // The parent plugin's own update already passed the trust gate.
          provenance: "verified" as const,
          // User edits are at stake, so the diff is always shown first.
          permissionsExpanded: (row.userEditedFields ?? 0) > 0,
        }))
    },

    async apply(
      candidate: UpdateCandidate,
      _context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      if (!deps.openDiff) {
        return { state: "failed", failure: { kind: "unsupported", code: "no_pack_diff" } }
      }
      await deps.openDiff(candidate.assetId)
      // The dialog owns the outcome. The row goes back to available until the
      // next check confirms the pack version actually moved.
      return { state: "available" }
    },
  }
}
