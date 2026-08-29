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
// The one place this repo already decided how short a CONTENT query may be —
// titles match from one character, message bodies do not, because a
// one-character scan over every turn is noise rather than a search. The module
// is type-only at the top level, so it stays off the trigger detector's
// runtime path.
import { CONTENT_SEARCH_MIN_QUERY } from "@/lib/chat/conversation-search-scope"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
// Statically imported even though this module is on the pure trigger
// detector's path: `entity-cache` pulls only `lib/global-search/cache.ts`,
// which imports nothing at all. A dynamic import here would buy nothing and
// would make the test reset below unable to drop the caches synchronously.
import { invalidateEntityMentionCaches, loadEntityCandidates } from "./entity-cache"

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
  /**
   * Every candidate this source can offer in this context, with `searchText`
   * already built. Cached per `(kind, projectId, sessionId)` by
   * `lib/chat/mentions/entity-cache.ts`, so the store is read once per picking
   * session instead of once per keystroke — and the lowercased haystacks are
   * built once with it.
   *
   * This is the shape for a source whose corpus can be listed. A source whose
   * corpus cannot (one backed by a search engine rather than a table)
   * implements {@link search} instead. Exactly one of the two is required.
   */
  load?(ctx: EntityMentionContext): Promise<EntityMentionCandidate[]>
  /**
   * Candidates matching `query` (already trimmed; may be empty = "recent").
   *
   * Defaults to a substring filter over the cached {@link load} result. Only a
   * source that must push the query down to its own engine overrides it — and
   * then it owns its own cost control, because nothing caches per query.
   */
  search?(query: string, ctx: EntityMentionContext): Promise<EntityMentionCandidate[]>
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
  if (!source.load && !source.search) {
    throw new Error(
      `entity mention source "${source.entityKind}" must implement load() or search()`
    )
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
  // A single message is a slice of a conversation, so it inherits the
  // conversation's authorship problem exactly — and more sharply, because a
  // `@msg:` body deliberately carries the TOOL OUTPUT the transcript snapshot
  // drops. That is the part most likely to be text the web wrote.
  "message",
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

/**
 * Run one source's search — the single entry the panel calls.
 *
 * A `search`-implementing source owns its own query; a `load`-implementing one
 * gets the cached list plus the shared substring filter. Splitting it here
 * rather than inside each source is what keeps "the store is read once per
 * picking session" a property of the registry instead of a discipline every
 * new source has to remember.
 */
export async function searchEntityMentionCandidates(
  source: EntityMentionSource,
  query: string,
  ctx: EntityMentionContext
): Promise<EntityMentionCandidate[]> {
  if (source.search) return source.search(query, ctx)
  return take(await loadEntityCandidates(source, ctx), query)
}

interface MessageCandidateInput {
  sessionId: string
  messageId: string
  sessionTitle: string
  role: string
  createdAt: number
  excerpt: string
  refId: string
}

/**
 * One `@msg:` row.
 *
 * Titled by the CONVERSATION, subtitled by the excerpt: a message has no name,
 * and "which conversation, and roughly what was said" is what lets a person
 * recognise the one they meant. The excerpt is the engine's own snippet, so the
 * row reads the same as the ⌘K hit it came from.
 */
function messageCandidate(input: MessageCandidateInput): EntityMentionCandidate {
  const date = new Date(input.createdAt).toISOString().slice(0, 10)
  return {
    entityKind: "message",
    id: input.refId,
    title: input.sessionTitle,
    subtitle: `${input.role} · ${date} · ${input.excerpt}`.slice(0, 200),
    // The permalink, so the chip opens the exact message rather than the
    // conversation's tail — `hooks/chat/use-message-permalink.ts` consumes it.
    href: `/?session=${encodeURIComponent(input.sessionId)}&message=${encodeURIComponent(input.messageId)}`,
    searchText: haystack(input.sessionTitle, input.excerpt, input.role),
  }
}

// ---------------------------------------------------------------------------
// Built-in sources
// ---------------------------------------------------------------------------

function registerBuiltinEntityMentionSources(): void {
  registerEntityMentionSource({
    entityKind: "memory",
    prefix: "memory:",
    async load(ctx) {
      const { listMemories } = await import("@/lib/db/memories")
      // `status: "active"` and nothing else: an invalidated or superseded
      // memory is exactly the material a user must not accidentally re-assert.
      const rows = await listMemories({
        status: "active",
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      })
      return rows.map((m) => ({
        entityKind: "memory" as const,
        id: m.id,
        // A memory has no title — its text IS the statement, so the first
        // line stands in and the row shows the scope beside it.
        title: m.text.split("\n")[0]?.slice(0, 120) || m.id,
        subtitle: `${m.type} · ${m.scope}`,
        href: "/memory",
        searchText: haystack(m.text, m.type, m.scope, m.tags.join(" ")),
      }))
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
    async load(ctx) {
      const { listIssues } = await import("@/lib/db/issues")
      const rows = await listIssues(ctx.projectId ? { projectId: ctx.projectId } : {})
      return rows.map((issue) => ({
        entityKind: "issue" as const,
        id: issue.id,
        title: issue.title,
        subtitle: `${issue.identifier} · ${issue.status}`,
        href: `/issues?id=${encodeURIComponent(issue.id)}`,
        // The identifier is what people actually type (`COG-14`), so it has
        // to be in the haystack even though it is not the title.
        searchText: haystack(issue.identifier, issue.title, issue.description, issue.status),
      }))
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
    async load(ctx) {
      const { listAllPlans } = await import("@/lib/db/plans")
      const rows = await listAllPlans(200, ctx.projectId ?? undefined)
      return rows.map((plan) => ({
        entityKind: "plan" as const,
        id: plan.id,
        title: plan.title,
        subtitle: `${plan.status} · ${plan.completedSteps}/${plan.totalSteps}`,
        searchText: haystack(plan.title, plan.description, plan.status),
      }))
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
    async load(ctx) {
      const { listSessions } = await import("@/lib/db/sessions")
      const { filterExposedSessions } = await import("@/lib/chat/session-exposure")
      const rows = await listSessions()
      return (
        // A subagent's inner transcript, a resource-workbench aside and a
        // workflow-editor session are all `embedded`: they are reachable from
        // the turn that owns them, never from a list. Offering them here made
        // the panel's idea of "a conversation" disagree with every other
        // surface in the app — this is the same channel ⌘K asks about.
        filterExposedSessions(rows, "global-search")
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
          }))
      )
    },
    async snapshot(candidate) {
      const { getSessionTranscriptText } = await import("./entity-transcript")
      return getSessionTranscriptText(candidate.id)
    },
  })

  registerEntityMentionSource({
    entityKind: "message",
    prefix: "msg:",
    // `search`, not `load`: the corpus here is every message in the account.
    // The ADR-0099 engine already holds a resident, tuned index of exactly that
    // — and until now nothing in the composer used it, so `@chat:` could only
    // match a conversation by its TITLE. Finding the conversation where a thing
    // was discussed is the whole reason a person reaches for a reference.
    async search(query, ctx) {
      const { pendingSearchRows } = await import("@/lib/chat/search/pending-rows")
      const { messageRefId } = await import("./message-reference")
      const scope = ctx.projectId ? { projectId: ctx.projectId } : {}

      // Short queries do not reach the engine: one letter would scan the whole
      // resident haystack. The empty-query case is not a search at all — it is
      // "the most recent messages", which the index answers directly.
      if (query.length > 0 && query.length < CONTENT_SEARCH_MIN_QUERY) return []

      if (query.length === 0) {
        const { loadNewestChatSearchText } = await import("@/lib/db/chat-search-text")
        const { getDb } = await import("@/lib/db/schema")
        const rows = (await loadNewestChatSearchText(ENTITY_MENTION_RESULT_LIMIT * 3))
          .filter((row) => !ctx.projectId || !row.projectId || row.projectId === ctx.projectId)
          .slice(0, ENTITY_MENTION_RESULT_LIMIT)
        const sessions = await getDb().sessions.bulkGet(rows.map((row) => row.sessionId))
        const titles = new Map(
          sessions.filter(Boolean).map((s) => [s!.id, s!.title || s!.id] as const)
        )
        return rows.map((row) =>
          messageCandidate({
            sessionId: row.sessionId,
            messageId: row.messageId,
            sessionTitle: titles.get(row.sessionId) ?? row.sessionId,
            role: row.role,
            createdAt: row.createdAt,
            excerpt: row.text,
            refId: messageRefId(row.sessionId, row.messageId),
          })
        )
      }

      const { searchChatHistory } = await import("@/lib/chat/search/engine")
      const outcome = await searchChatHistory(
        {
          query,
          limit: ENTITY_MENTION_RESULT_LIMIT,
          ...scope,
          // One hit per conversation would hide the second half of an exchange
          // in the very conversation the user is aiming at — the opposite of
          // what a message-level reference is for.
          collapseBySession: false,
        },
        { pendingRows: pendingSearchRows }
      )
      return outcome.results.map((hit) =>
        messageCandidate({
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          sessionTitle: hit.sessionTitle || hit.sessionId,
          role: hit.role,
          createdAt: hit.createdAt,
          excerpt: hit.snippet.text,
          refId: messageRefId(hit.sessionId, hit.messageId),
        })
      )
    },
    async snapshot(candidate) {
      const { buildMessageReferenceText, parseMessageRefId } = await import("./message-reference")
      const parsed = parseMessageRefId(candidate.id)
      if (!parsed) return null
      return buildMessageReferenceText(parsed)
    },
  })

  registerEntityMentionSource({
    entityKind: "artifact",
    prefix: "artifact:",
    async load(ctx) {
      // Artifacts live in the persisted Zustand store, not in Dexie — reading
      // `useArtifactStore.getState()` is the same access the plugin Artifact
      // API uses, so there is no second notion of "every artifact".
      const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
      const rows = Object.values(useArtifactStore.getState().artifacts)
      return rows
        .filter((a) => !ctx.projectId || !a.projectId || a.projectId === ctx.projectId)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map((a) => ({
          entityKind: "artifact" as const,
          id: a.id,
          title: a.title,
          subtitle: a.language ? `${a.type} · ${a.language}` : a.type,
          searchText: haystack(a.title, a.type, a.language),
        }))
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
  // The caches are keyed by entity kind, so a re-registered source would
  // otherwise inherit the previous registration's candidate list.
  invalidateEntityMentionCaches()
  registerBuiltinEntityMentionSources()
}

registerBuiltinEntityMentionSources()
