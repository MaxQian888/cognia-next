/**
 * Entity mention sources — what `@memory:`, `@issue:`, `@plan:`, `@chat:` and
 * `@artifact:` reach.
 *
 * Registry shape is copied from `lib/docs-providers/registry.ts` on purpose
 * (module-level map, duplicate registration throws, test reset re-seeds the
 * built-ins): adding a sixth referenceable record should be a
 * `registerEntityMentionSource` call, not an edit to the composer or the
 * popover. `components/chat/composer-trigger.ts` reads `entityMentionPrefixes()`
 * on every call for the same reason it reads `docsProviderPrefixes()` — a test
 * that resets the registry must not leave the trigger's prefix list stale.
 *
 * Why these five and not the whole ⌘K catalogue: a mention has to produce TEXT
 * a model can read. A memory, an issue, a plan, a conversation and an artifact
 * all have a body. A workflow or a template is a thing you RUN — pasting its
 * definition into a prompt teaches the model nothing it can act on, and there
 * are already `/workflow` and the template picker for running them.
 *
 * Every source is Dexie-backed and therefore works on every shell, which is the
 * other half of the point: `@` on a phone or in a plain browser previously
 * reached almost nothing, because the file picker needs a host to search and
 * both document providers are `hosts: ["tauri"]`.
 *
 * Loading is lazy on purpose. This module is imported (transitively) by the
 * pure trigger detector, so a top-level `import { listMemories } from
 * "@/lib/db/memories"` would drag Dexie into the module-load path of a
 * render-free module and into every composer unit test. The bodies below
 * `await import(...)` instead, so the registry itself stays free of it.
 */

import type { EntitySelectionKind, EntitySelectionRef } from "@/types/artifact/artifact"
import { truncationMarker } from "@/lib/docs-providers/limits"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"

/**
 * Characters kept from one referenced record.
 *
 * Much tighter than `MAX_DOC_CHARS` (200k) because this text is inlined into
 * the PROMPT BODY by `formatContextSelectionsForLLM`, not staged as an
 * attachment — there is no separate extraction step to bound it later. The
 * composer's `INLINE_TOKEN_CEILING` confirmation still applies on top.
 */
export const MAX_ENTITY_SNAPSHOT_CHARS = 20_000

/** Candidates offered per source for one query. */
export const ENTITY_MENTION_RESULT_LIMIT = 12

/** One row in the `@<prefix>` panel. */
export interface EntityMentionCandidate {
  entityKind: EntitySelectionKind
  /** The record's own id. Round-trips into `EntitySelectionRef.entityId`. */
  id: string
  title: string
  /** Second line on the row and on the chip — status, scope, counts. */
  subtitle?: string
  /** In-app route the staged chip links back to, when the kind has one. */
  href?: string
  /** Pre-lowercased haystack for fuzzy matching (title + subtitle + id). */
  searchText: string
}

/** What a source needs to know about where the composer is. */
export interface EntityMentionContext {
  /** Active workspace, for the kinds that are workspace-scoped. */
  projectId?: string | null
  /** The conversation being composed in — `@artifact:` and `@chat:` use it. */
  sessionId?: string | null
}

export interface EntityMentionSource {
  entityKind: EntitySelectionKind
  /** Namespace typed after the `@`, including the colon (`"memory:"`). */
  prefix: string
  /** Candidates matching `query` (already trimmed; may be empty = "recent"). */
  search(query: string, ctx: EntityMentionContext): Promise<EntityMentionCandidate[]>
  /**
   * The record's body, as the model should read it. Returns null when the
   * record vanished between the pick and the read (deleted in another window),
   * so the caller can say so instead of staging an empty chip.
   */
  snapshot(candidate: EntityMentionCandidate): Promise<string | null>
}

const sources = new Map<EntitySelectionKind, EntityMentionSource>()

export function registerEntityMentionSource(source: EntityMentionSource): void {
  if (sources.has(source.entityKind)) {
    throw new Error(`entity mention source "${source.entityKind}" already registered`)
  }
  if (!source.prefix.endsWith(":")) {
    throw new Error(
      `entity mention source "${source.entityKind}" prefix must end with ":" (got "${source.prefix}")`
    )
  }
  for (const other of sources.values()) {
    if (other.prefix === source.prefix) {
      throw new Error(
        `entity mention source "${source.entityKind}" claims prefix "${source.prefix}" already used by "${other.entityKind}"`
      )
    }
  }
  sources.set(source.entityKind, source)
}

/** Remove one dynamically contributed source. Built-ins are never removed. */
export function unregisterEntityMentionSource(kind: EntitySelectionKind): boolean {
  return sources.delete(kind)
}

export function getEntityMentionSource(kind: EntitySelectionKind): EntityMentionSource | undefined {
  return sources.get(kind)
}

/** Every registered source, in registration order. */
export function listEntityMentionSources(): EntityMentionSource[] {
  return [...sources.values()]
}

/** `{ prefix, entityKind }` per source — consumed by `detectTrigger`. */
export function entityMentionPrefixes(): { prefix: string; entityKind: EntitySelectionKind }[] {
  return listEntityMentionSources().map((s) => ({ prefix: s.prefix, entityKind: s.entityKind }))
}

/** Resolve the source owning a namespace prefix (`"issue:"`). */
export function getEntityMentionSourceByPrefix(prefix: string): EntityMentionSource | undefined {
  return listEntityMentionSources().find((s) => s.prefix === prefix)
}

/**
 * Clamp one record's body, appending the same visible marker a truncated remote
 * document gets. Silent truncation is the failure mode this exists to prevent:
 * the model would answer confidently from a plan missing its last three steps.
 */
export function clampEntitySnapshot(text: string): string {
  if (text.length <= MAX_ENTITY_SNAPSHOT_CHARS) return text
  return (
    text.slice(0, MAX_ENTITY_SNAPSHOT_CHARS) +
    truncationMarker("this record", MAX_ENTITY_SNAPSHOT_CHARS, "characters")
  )
}

/**
 * Which kinds get the untrusted-content preamble.
 *
 * The line is authorship, not storage location. An issue can be mirrored from
 * GitHub or filed straight out of an IM thread, and a conversation can contain
 * inbound platform messages and whatever a tool read off the web — text written
 * by someone who is not the user, which must not read to the model as
 * instructions.
 *
 * `memory` is on that side of the line too, which is easy to miss because the
 * user is the one who saved it. A memory body is frequently DISTILLED rather
 * than typed: `lib/memory/` extracts them from transcripts that can contain
 * `web_fetch` output, and `lib/twin/ingest/url-fetcher.ts` ingests pages
 * directly. So the same third-party prose the `web` selection kind wraps can
 * arrive here under a `Stored memory "…"` heading with nothing framing it. The
 * preamble costs a sentence; a distilled memory carrying an injected
 * instruction costs the turn.
 *
 * A plan and an artifact stay unwrapped: both are authored inside this app by
 * the user or the agent as work to be continued, and a plan prefixed with a
 * do-not-follow notice is worse than no plan.
 */
const UNTRUSTED_ENTITY_KINDS: ReadonlySet<EntitySelectionKind> = new Set([
  "issue",
  "session",
  "memory",
])

export function entitySnapshotBody(kind: EntitySelectionKind, text: string): string {
  const clamped = clampEntitySnapshot(text)
  return UNTRUSTED_ENTITY_KINDS.has(kind) ? wrapUntrustedContent(clamped) : clamped
}

/** Build the staged selection for a picked candidate. */
export function entitySelectionFrom(
  candidate: EntityMentionCandidate,
  snapshot: string
): EntitySelectionRef {
  return {
    kind: "entity",
    entityKind: candidate.entityKind,
    entityId: candidate.id,
    title: candidate.title,
    snapshot: entitySnapshotBody(candidate.entityKind, snapshot),
    comment: "",
    ...(candidate.subtitle ? { subtitle: candidate.subtitle } : {}),
    ...(candidate.href ? { href: candidate.href } : {}),
  }
}

/** Lowercased haystack, skipping the blanks so `undefined` never matches. */
function haystack(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ").toLocaleLowerCase()
}

/** Case-insensitive substring match over the haystack; empty query matches all. */
function matches(candidate: EntityMentionCandidate, query: string): boolean {
  if (!query) return true
  return candidate.searchText.includes(query.toLocaleLowerCase())
}

function take(candidates: EntityMentionCandidate[], query: string): EntityMentionCandidate[] {
  return candidates.filter((c) => matches(c, query)).slice(0, ENTITY_MENTION_RESULT_LIMIT)
}

// ---------------------------------------------------------------------------
// Built-in sources
// ---------------------------------------------------------------------------

function registerBuiltinEntityMentionSources(): void {
  registerEntityMentionSource({
    entityKind: "memory",
    prefix: "memory:",
    async search(query, ctx) {
      const { listMemories } = await import("@/lib/db/memories")
      // `status: "active"` and nothing else: an invalidated or superseded
      // memory is exactly the material a user must not accidentally re-assert.
      const rows = await listMemories({
        status: "active",
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      })
      return take(
        rows.map((m) => ({
          entityKind: "memory" as const,
          id: m.id,
          // A memory has no title — its text IS the statement, so the first
          // line stands in and the row shows the scope beside it.
          title: m.text.split("\n")[0]?.slice(0, 120) || m.id,
          subtitle: `${m.type} · ${m.scope}`,
          href: "/memory",
          searchText: haystack(m.text, m.type, m.scope, m.tags.join(" ")),
        })),
        query
      )
    },
    async snapshot(candidate) {
      const { getMemory } = await import("@/lib/db/memories")
      const row = await getMemory(candidate.id)
      return row ? row.text : null
    },
  })

  registerEntityMentionSource({
    entityKind: "issue",
    prefix: "issue:",
    async search(query, ctx) {
      const { listIssues } = await import("@/lib/db/issues")
      const rows = await listIssues(ctx.projectId ? { projectId: ctx.projectId } : {})
      return take(
        rows.map((issue) => ({
          entityKind: "issue" as const,
          id: issue.id,
          title: issue.title,
          subtitle: `${issue.identifier} · ${issue.status}`,
          href: `/issues?id=${encodeURIComponent(issue.id)}`,
          // The identifier is what people actually type (`COG-14`), so it has
          // to be in the haystack even though it is not the title.
          searchText: haystack(issue.identifier, issue.title, issue.description, issue.status),
        })),
        query
      )
    },
    async snapshot(candidate) {
      const { getIssue } = await import("@/lib/db/issues")
      const issue = await getIssue(candidate.id)
      if (!issue) return null
      const lines = [
        `${issue.identifier}: ${issue.title}`,
        `Status: ${issue.status} · Priority: ${issue.priority}`,
      ]
      if (issue.description?.trim()) lines.push("", issue.description.trim())
      return lines.join("\n")
    },
  })

  registerEntityMentionSource({
    entityKind: "plan",
    prefix: "plan:",
    async search(query, ctx) {
      const { listAllPlans } = await import("@/lib/db/plans")
      const rows = await listAllPlans(200, ctx.projectId ?? undefined)
      return take(
        rows.map((plan) => ({
          entityKind: "plan" as const,
          id: plan.id,
          title: plan.title,
          subtitle: `${plan.status} · ${plan.completedSteps}/${plan.totalSteps}`,
          searchText: haystack(plan.title, plan.description, plan.status),
        })),
        query
      )
    },
    async snapshot(candidate) {
      const { getPlan } = await import("@/lib/db/plans")
      const plan = await getPlan(candidate.id)
      if (!plan) return null
      const lines = [
        `Plan: ${plan.title}`,
        `Status: ${plan.status} (${plan.completedSteps}/${plan.totalSteps} steps done)`,
      ]
      if (plan.description?.trim()) lines.push("", plan.description.trim())
      if (plan.steps.length > 0) {
        lines.push("", "Steps:")
        // Numbered with the status in front: a bare list of titles loses the
        // one thing the agent needs, which is where the plan actually stopped.
        plan.steps.forEach((step, index) => {
          lines.push(`${index + 1}. [${step.status}] ${step.title}`)
        })
      }
      return lines.join("\n")
    },
  })

  registerEntityMentionSource({
    entityKind: "session",
    prefix: "chat:",
    async search(query, ctx) {
      const { listSessions } = await import("@/lib/db/sessions")
      const rows = await listSessions()
      return take(
        rows
          // Never offer the conversation you are composing in. Its transcript
          // is already the context — staging a snapshot of it would duplicate
          // every message the model can see anyway.
          .filter((s) => s.id !== ctx.sessionId)
          .filter((s) => !ctx.projectId || !s.projectId || s.projectId === ctx.projectId)
          .map((s) => ({
            entityKind: "session" as const,
            id: s.id,
            title: s.title || s.id,
            subtitle: new Date(s.updatedAt).toISOString().slice(0, 10),
            href: `/?session=${encodeURIComponent(s.id)}`,
            searchText: haystack(s.title, s.id),
          })),
        query
      )
    },
    async snapshot(candidate) {
      const { getSessionTranscriptText } = await import("./entity-transcript")
      return getSessionTranscriptText(candidate.id)
    },
  })

  registerEntityMentionSource({
    entityKind: "artifact",
    prefix: "artifact:",
    async search(query, ctx) {
      // Artifacts live in the persisted Zustand store, not in Dexie — reading
      // `useArtifactStore.getState()` is the same access the plugin Artifact
      // API uses, so there is no second notion of "every artifact".
      const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
      const rows = Object.values(useArtifactStore.getState().artifacts)
      return take(
        rows
          .filter((a) => !ctx.projectId || !a.projectId || a.projectId === ctx.projectId)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .map((a) => ({
            entityKind: "artifact" as const,
            id: a.id,
            title: a.title,
            subtitle: a.language ? `${a.type} · ${a.language}` : a.type,
            searchText: haystack(a.title, a.type, a.language),
          })),
        query
      )
    },
    async snapshot(candidate) {
      const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
      const artifact = useArtifactStore.getState().artifacts[candidate.id]
      return artifact ? artifact.content : null
    },
  })
}

/** Test-only: restore the registry to exactly the built-in set. */
export function __resetEntityMentionSourcesForTests(): void {
  sources.clear()
  registerBuiltinEntityMentionSources()
}

registerBuiltinEntityMentionSources()
