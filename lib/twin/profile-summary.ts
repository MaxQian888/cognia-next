/**
 * Single source of truth for projecting a raw {@link TwinProfile} Dexie row
 * into the compact summary shown in the Discover surfaces.
 *
 * The mobile panel receives the row through the `twin_profile_get` companion
 * RPC and the desktop card reads it straight from Dexie, but both render the
 * same shape — so the projection lives here and is shared by both. Keeping it
 * pure also makes it trivially testable away from React/Dexie.
 */

import type { TwinProfile } from "@/types/twin"

export interface TwinProfileSummary {
  twinId: string
  /** ms-since-epoch of the last distill write, if the profile has any content. */
  updatedAt?: number
  /** Number of distilled style samples. */
  sampleCount: number
  /** Number of distilled entities (people / projects). */
  entityCount: number
  /** The prose voice summary, omitted when empty so the UI can hide its block. */
  styleSummary?: string
}

export function summarizeTwinProfile(
  profile: TwinProfile | null | undefined
): TwinProfileSummary | null {
  // The mobile path receives this straight off an untyped companion RPC, so
  // guard against anything that isn't a real profile object (null, arrays,
  // partial junk) rather than trusting the static type.
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null
  const styleSamples = Array.isArray(profile.styleSamples) ? profile.styleSamples : []
  const entities = Array.isArray(profile.entities) ? profile.entities : []
  const voiceSummary = typeof profile.voiceSummary === "string" ? profile.voiceSummary : ""
  return {
    twinId: profile.twinId,
    updatedAt: profile.updatedAt,
    sampleCount: styleSamples.length,
    entityCount: entities.length,
    styleSummary: voiceSummary.trim() ? voiceSummary : undefined,
  }
}
