/**
 * Which ⌘K results can be referenced into the composer, and as what.
 *
 * ⌘K could already FIND a message in another conversation — the messages
 * provider has run on the ADR-0099 engine since it shipped — but the only thing
 * a hit could do was navigate. You searched for the thing you wanted to reuse,
 * found it, and then had to go and find it a second time from the `@` panel.
 *
 * This is the missing half, and it is deliberately a translation rather than a
 * second staging path: a row is turned into the same `EntityMentionCandidate`
 * the `@` panel produces, and handed to the same
 * `useEntityMentionStaging`. A reference made here and one made in the composer
 * are then byte-identical — same chip, same prompt heading, same citation, same
 * untrusted wrapping — because they ARE the same code.
 *
 * Only the kinds whose records have a body a model can read: the mention
 * registry already drew that line (`entity-sources.ts` explains why a workflow
 * is not on it), so this reads the registry rather than re-deciding.
 */

import type { EntityMentionCandidate } from "@/lib/chat/mentions/entity-sources"
import { messageRefId } from "@/lib/chat/mentions/message-reference"
import type { EntitySelectionKind } from "@/types/artifact/artifact"
import type { GlobalSearchItem, GlobalSearchKind } from "./types"

/**
 * ⌘K kind → the record kind a reference would stage.
 *
 * `session` and `message` are the two that matter and the two that could not
 * be expressed before: a conversation is `@chat:`, and a message hit is the
 * `@msg:` granularity ⌘K has always been able to FIND and never able to hand
 * over. `plan` and `artifact` are absent because ⌘K has no provider for
 * either — the map is keyed by what the palette actually produces.
 */
const REFERENCEABLE_KINDS: Partial<Record<GlobalSearchKind, EntitySelectionKind>> = {
  session: "session",
  message: "message",
  memory: "memory",
  issue: "issue",
}

/**
 * The candidate a row would stage, or null when the row is not referenceable.
 *
 * Returns null rather than throwing for an unreferenceable kind: this is asked
 * once per rendered row to decide whether to draw the control, so "no" is an
 * ordinary answer.
 */
export function referenceCandidateFor(item: GlobalSearchItem): EntityMentionCandidate | null {
  const entityKind = REFERENCEABLE_KINDS[item.kind]
  if (!entityKind) return null

  // ⌘K item ids are namespaced (`message:<id>`, `chat:<id>`) so they can be
  // unique across providers; the record's own id is what a reference needs.
  const recordId = item.id.slice(item.id.indexOf(":") + 1)
  if (!recordId) return null

  const base = {
    entityKind,
    title: item.title,
    searchText: "",
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
  }

  if (entityKind === "message") {
    // A message reference is addressed by conversation AND message, and the
    // action carries the session because the row's id cannot.
    const sessionId = item.extra?.sessionId
    if (typeof sessionId !== "string" || !sessionId) return null
    return {
      ...base,
      id: messageRefId(sessionId, recordId),
      href: `/?session=${encodeURIComponent(sessionId)}&message=${encodeURIComponent(recordId)}`,
    }
  }

  return { ...base, id: recordId }
}

/** Cheap predicate for the row renderer. */
export function isReferenceable(item: GlobalSearchItem): boolean {
  return referenceCandidateFor(item) !== null
}
