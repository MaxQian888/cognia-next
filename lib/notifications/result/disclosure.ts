// Notification V2 disclosure — the per-target content ceiling.
//
// Every fact carries a classification; every target carries a disclosure
// profile whose `maxLevel` is the ceiling it may receive. Rendering for a
// target clips facts ABOVE its ceiling — the ceiling only ever narrows, a
// higher-priority rule can never widen it. A clipped fact becomes a "+N
// more" marker, never its content, and an artifact link / detail link is
// dropped entirely when the profile forbids it — a link is a disclosure too.
//
// This is target-specific: the same notification renders a full card for an
// `internal` bound conversation and a counts-only line for a `public`
// webhook. Privacy mode additionally strips business titles from the headline.

import {
  disclosureProfileById,
  NOTIFICATION_DISCLOSURE_RANK,
  type NotificationDisclosureProfile,
  type NotificationDisclosureLevel,
} from "@/types/notifications/target"
import type { RunResultFact, NotificationRenderedPayload } from "@/types/notifications/result"
import type { NotificationLevel } from "@/types/notifications"
import { payloadContentHash } from "./builder"

export interface DisclosureClipResult {
  /** Facts at or below the ceiling — renderable. */
  visibleFacts: RunResultFact[]
  /** Facts above the ceiling — counted, never shown. */
  clippedFactCount: number
  /** The disclosure level actually applied to the render. */
  appliedLevel: NotificationDisclosureLevel
}

/**
 * Clip a fact set to a disclosure profile. Facts are kept verbatim at/below
 * the ceiling; anything above is dropped and counted. The applied level is
 * the richest classification that survived (or the ceiling if none did).
 */
export function clipFactsToProfile(
  facts: readonly RunResultFact[],
  profile: NotificationDisclosureProfile
): DisclosureClipResult {
  const ceiling = NOTIFICATION_DISCLOSURE_RANK[profile.maxLevel]
  const visibleFacts: RunResultFact[] = []
  let clippedFactCount = 0
  let appliedLevel: NotificationDisclosureLevel = "public"
  for (const fact of facts) {
    if (NOTIFICATION_DISCLOSURE_RANK[fact.classification] <= ceiling) {
      visibleFacts.push(fact)
      if (
        NOTIFICATION_DISCLOSURE_RANK[fact.classification] >
        NOTIFICATION_DISCLOSURE_RANK[appliedLevel]
      ) {
        appliedLevel = fact.classification
      }
    } else {
      clippedFactCount += 1
    }
  }
  return { visibleFacts, clippedFactCount, appliedLevel }
}

/**
 * Render a target-specific payload from a summary's facts + headline.
 * `profile` is the target's disclosure profile; `level` is the notification's
 * severity (carried through, not derived here). `privacyMode` redacts the
 * business title into a generic one — used for lock-screen / low-trust
 * surfaces where the title itself is a disclosure.
 */
export function renderDisclosedPayload(input: {
  title: string
  genericTitle: string
  level: NotificationLevel
  facts: readonly RunResultFact[]
  profileId: string
  /** Optional deep-link ref — dropped when the profile forbids detail links. */
  detailRef?: string
  profiles?: readonly NotificationDisclosureProfile[]
}): NotificationRenderedPayload {
  const profile = disclosureProfileById(input.profileId, input.profiles)
  const { visibleFacts, clippedFactCount, appliedLevel } = clipFactsToProfile(input.facts, profile)
  const title = profile.privacyMode ? input.genericTitle : input.title
  const bodyLines = visibleFacts
    .filter((f) => !f.redacted)
    .map((f) => {
      // Artifact links only travel when the profile allows them — a link is a
      // disclosure channel, not just a convenience.
      if (f.artifactRef && !profile.allowArtifactLinks) return f.text
      return f.artifactRef ? `${f.text} (${f.artifactRef})` : f.text
    })
  if (clippedFactCount > 0) bodyLines.push(`+${clippedFactCount} more`)
  const actions =
    profile.allowDetailLink && input.detailRef
      ? [{ kind: "open", label: "Open", ref: input.detailRef }]
      : undefined
  const body = bodyLines.join("\n")
  return {
    title,
    body,
    level: input.level,
    ...(actions ? { actions } : {}),
    disclosureLevel: appliedLevel,
    clippedFactCount,
    contentHash: payloadContentHash({ title, body, actions }),
  }
}
