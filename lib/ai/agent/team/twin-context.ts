/**
 * Employee Digital Twin runtime glue for the Agent Team dispatch path
 * (ADR-0003 × ADR-0022). Two concerns:
 *
 *  1. `resolveTeamTwinRuntime` — called ONCE per team run in `runTeamLifecycle`.
 *     Gathers the per-run `twinDeps` (a shared vector-store client, built only
 *     when the team actually uses a twin) plus a content-free summary of the
 *     twins the lead may recruit / consult. Best-effort: returns `{ twinDeps:
 *     undefined, availableTwins: [] }` when the twin runtime isn't configured
 *     or Dexie is unreachable (headless/CLI), so callers short-circuit cleanly.
 *
 *  2. `applyTeammateTwinContext` — inject a twin's persona (voice / playbooks /
 *     entities) + per-task RAG knowledge into a system prompt for the
 *     TEXT-ONLY dispatch channel (`executeAgent` on web/mobile) and for
 *     `delegateToTwin`. The desktop SIDECAR channel does NOT use this — it
 *     threads `twinDeps` + the task prompt into `resolveSendOptions`, which
 *     calls `applyTwinContext` itself. We cannot reuse the workflow
 *     `injectTwinContext` helper here because it does `getCharacter(id)` (a DB
 *     lookup), while a teammate's `Character` is synthesized in memory
 *     (`__teammate__:*`) and never persisted.
 *
 * Never throws — twin failures degrade to the base prompt and are logged to the
 * M6 inject-log ring buffer so the Twin settings UI can surface them.
 */

import type { Character } from "@cognia/agent-config-types"
import type { ApplyTwinContextDeps } from "@/lib/twin/runtime/apply-twin-context"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"
import type { TwinSettings } from "@/types/twin"
import type { TeamTwinSummary } from "./team-run-context"

/** Default / max knowledge hits returned by `searchTwinKnowledge`. */
const DEFAULT_TWIN_SEARCH_TOPK = 5
const MAX_TWIN_SEARCH_TOPK = 12

/** Max characters of expertise blurb carried per twin in the recruit summary. */
const MAX_EXPERTISE_CHARS = 240
/** Max key entities appended to a twin's expertise blurb. */
const MAX_EXPERTISE_ENTITIES = 6

export interface ResolveTeamTwinRuntimeOptions {
  /** Build the shared vector-store `twinDeps` (needed for any twin injection). */
  buildDeps: boolean
  /** Enumerate recruitable twins (needed only when the run can re-staff). */
  listAvailable: boolean
}

export interface TeamTwinRuntime {
  twinDeps?: TwinRuntimeDepsForBuild
  availableTwins: TeamTwinSummary[]
}

/**
 * Resolve the per-run twin runtime. Both halves are independently gated + fully
 * best-effort so a twin misconfiguration never blocks a team run.
 */
export async function resolveTeamTwinRuntime(
  opts: ResolveTeamTwinRuntimeOptions
): Promise<TeamTwinRuntime> {
  const [twinDeps, availableTwins] = await Promise.all([
    opts.buildDeps ? tryBuildDepsSafe() : Promise.resolve(undefined),
    opts.listAvailable ? gatherTeamTwins() : Promise.resolve<TeamTwinSummary[]>([]),
  ])
  return { ...(twinDeps ? { twinDeps } : {}), availableTwins }
}

async function tryBuildDepsSafe(): Promise<TwinRuntimeDepsForBuild | undefined> {
  try {
    const { tryBuildTwinDeps } = await import("@/lib/twin/runtime/build-deps")
    return await tryBuildTwinDeps()
  } catch {
    return undefined
  }
}

/**
 * List non-archived twins with a short, content-free expertise blurb (voice
 * summary + a few key entity names). Used by the adaptive-replan recruit prompt.
 * Never throws — returns `[]` on any failure.
 */
export async function gatherTeamTwins(): Promise<TeamTwinSummary[]> {
  try {
    const [{ listTwins }, { getTwinProfile }] = await Promise.all([
      import("@/lib/db/twins"),
      import("@/lib/db/twin-profile"),
    ])
    const twins = await listTwins({ includeArchived: false })
    const summaries = await Promise.all(
      twins.map(async (t): Promise<TeamTwinSummary> => {
        let expertise = ""
        try {
          const profile = await getTwinProfile(t.id)
          expertise = summarizeExpertise(profile?.voiceSummary, profile?.entities)
        } catch {
          expertise = t.description?.trim() ?? ""
        }
        return { id: t.id, name: t.name, expertise }
      })
    )
    return summaries
  } catch {
    return []
  }
}

/** Compose a bounded expertise blurb from the profile's voice + entities. */
function summarizeExpertise(
  voiceSummary: string | undefined,
  entities: Array<{ name: string; role?: string }> | undefined
): string {
  const voice = (voiceSummary ?? "").trim()
  const names = (entities ?? [])
    .filter((e) => e.role === "project" || e.role === "system" || e.role === "concept")
    .map((e) => e.name)
    .slice(0, MAX_EXPERTISE_ENTITIES)
  const base =
    voice.length > MAX_EXPERTISE_CHARS ? `${voice.slice(0, MAX_EXPERTISE_CHARS - 1)}…` : voice
  const suffix = names.length ? ` [${names.join(", ")}]` : ""
  return `${base}${suffix}`.trim()
}

export interface ApplyTeammateTwinContextInput {
  /** The teammate/actor display name — surfaces in the twin identity block. */
  actorName: string
  /** The system prompt to wrap (the dispatch's resolved system prompt). */
  baseSystemPrompt: string
  /** The task/user prompt driving retrieval. */
  userPrompt: string
  twinId: string
  twinSettings?: TwinSettings
  /** The per-run shared vector-store deps (from `resolveTeamTwinRuntime`). */
  twinDeps: TwinRuntimeDepsForBuild
  /** Reuse a per-turn query embedding, if the caller already has one. */
  precomputedQueryEmbedding?: number[]
  /** Inject-log source tag, e.g. `"team"` / `"team-delegation"`. */
  source: string
}

export interface ApplyTeammateTwinContextResult {
  /** The system prompt to send — twin-injected when applied, else the base. */
  systemPrompt: string
  /** True when twin context was actually injected. */
  applied: boolean
  degradedReason?: string
}

/**
 * Build a twin-injected system prompt for a synthesized (in-memory) teammate
 * character. Mirrors what `resolveSendOptions` does internally for the sidecar
 * path, but callable directly for the text channel + delegation. Degrades to
 * `baseSystemPrompt` on any failure.
 */
export async function applyTeammateTwinContext(
  input: ApplyTeammateTwinContextInput
): Promise<ApplyTeammateTwinContextResult> {
  if (!input.userPrompt.trim()) {
    return { systemPrompt: input.baseSystemPrompt, applied: false }
  }
  try {
    const [{ applyTwinContext }, { recordTwinInject }] = await Promise.all([
      import("@/lib/twin/runtime/apply-twin-context"),
      import("@/lib/twin/runtime/inject-log"),
    ])
    const ts = Date.now()
    // Minimal synthetic character — applyTwinContext only reads twinId,
    // twinSettings, name (for the "You are …" identity line), and systemPrompt.
    const character: Character = {
      id: `__teammate_twin__:${input.twinId}`,
      name: input.actorName,
      avatarColor: "oklch(0.6 0 0)",
      systemPrompt: input.baseSystemPrompt,
      createdAt: ts,
      updatedAt: ts,
      twinId: input.twinId,
      ...(input.twinSettings ? { twinSettings: input.twinSettings } : {}),
    }
    const result = await applyTwinContext({
      character,
      userMessage: input.userPrompt,
      ...(input.precomputedQueryEmbedding
        ? { precomputedQueryEmbedding: input.precomputedQueryEmbedding }
        : {}),
      // `twinDeps` is the structural mirror declared in build-options; at
      // runtime the store is the real IVectorStore, so widening here is safe
      // (same cast the workflow twin-injector uses).
      deps: input.twinDeps as unknown as ApplyTwinContextDeps,
    })
    if (!result.applied) {
      recordTwinInject({
        ts,
        twinId: input.twinId,
        source: input.source,
        applied: false,
        degraded: result.degraded ?? false,
        degradedReason: result.degradedReason ?? null,
        chunkCount: 0,
        styleSampleCount: 0,
        tokensApprox: 0,
      })
      return {
        systemPrompt: input.baseSystemPrompt,
        applied: false,
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      }
    }
    const systemPrompt = result.applied.systemPrompt
    recordTwinInject({
      ts,
      twinId: input.twinId,
      source: input.source,
      applied: true,
      degraded: result.degraded ?? false,
      degradedReason: result.degradedReason ?? null,
      chunkCount: result.applied.metadata.retrievedChunkIds.length,
      styleSampleCount: result.applied.metadata.styleSampleIds.length,
      tokensApprox: Math.ceil(systemPrompt.length / 4),
    })
    return { systemPrompt, applied: true }
  } catch (err) {
    return {
      systemPrompt: input.baseSystemPrompt,
      applied: false,
      degradedReason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** One redacted knowledge hit returned to a teammate by `twin_knowledge_search`. */
export interface TwinKnowledgeHit {
  /** The chunk's REDACTED text (PII-safe — the raw `content` is never returned). */
  text: string
  sourceTitle?: string
  score: number
}

export interface SearchTwinKnowledgeInput {
  twinId: string
  query: string
  topK?: number
  twinDeps: TwinRuntimeDepsForBuild
}

export interface SearchTwinKnowledgeResult {
  hits: TwinKnowledgeHit[]
  degraded: boolean
  degradedReason?: string
}

/**
 * On-demand RAG over a twin's knowledge base for the `twin_knowledge_search`
 * team tool. Reuses the vetted `applyTwinContext` retrieval pipeline (dimension
 * guard / hybrid / rerank / corrective filter) to pick the chunks, then RE-LOADS
 * their `contentRedacted` so ONLY PII-scrubbed text is ever handed back to the
 * model — the raw `content` surfaced to the chat UI is deliberately dropped.
 * Never throws.
 */
export async function searchTwinKnowledge(
  input: SearchTwinKnowledgeInput
): Promise<SearchTwinKnowledgeResult> {
  if (!input.query.trim()) return { hits: [], degraded: false }
  try {
    const [{ applyTwinContext }, { getTwinChunksByVectorDocIds }, { DEFAULT_TWIN_SETTINGS }] =
      await Promise.all([
        import("@/lib/twin/runtime/apply-twin-context"),
        import("@/lib/db/twin-chunks"),
        import("@/types/twin"),
      ])
    const topK = Math.max(1, Math.min(MAX_TWIN_SEARCH_TOPK, input.topK ?? DEFAULT_TWIN_SEARCH_TOPK))
    const ts = Date.now()
    const character: Character = {
      id: `__twin_search__:${input.twinId}`,
      name: input.twinId,
      avatarColor: "oklch(0.6 0 0)",
      systemPrompt: "",
      createdAt: ts,
      updatedAt: ts,
      twinId: input.twinId,
      // Knowledge-only retrieval: force RAG on, drop style few-shot + citations.
      twinSettings: {
        ...DEFAULT_TWIN_SETTINGS,
        enableRag: true,
        ragTopK: topK,
        enableStyleFewShot: false,
        enableCitations: false,
      },
    }
    const result = await applyTwinContext({
      character,
      userMessage: input.query,
      deps: input.twinDeps as unknown as ApplyTwinContextDeps,
    })
    const retrieved = result.retrievedChunks
    if (retrieved.length === 0) {
      return {
        hits: [],
        degraded: result.degraded,
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
      }
    }
    // Re-load redacted text keyed by vectorDocId (retrievedChunks carry the RAW
    // content, which must never reach the model — the twin red-line).
    const chunks = await getTwinChunksByVectorDocIds(retrieved.map((c) => c.chunk.vectorDocId))
    const redactedByDocId = new Map(chunks.map((c) => [c.vectorDocId, c.contentRedacted]))
    const hits: TwinKnowledgeHit[] = retrieved
      .map((c) => ({
        text: redactedByDocId.get(c.chunk.vectorDocId) ?? "",
        ...(c.sourceTitle ? { sourceTitle: c.sourceTitle } : {}),
        score: c.score,
      }))
      .filter((h) => h.text.trim().length > 0)
    return {
      hits,
      degraded: result.degraded,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    }
  } catch (err) {
    return {
      hits: [],
      degraded: true,
      degradedReason: err instanceof Error ? err.message : String(err),
    }
  }
}
