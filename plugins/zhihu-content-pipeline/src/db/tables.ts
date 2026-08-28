/**
 * Plugin Dexie data layer (ADR plugin-dev/dexie-tables).
 *
 * Three namespaced tables (`zhihu-content-pipeline:<name>`, declared in the
 * manifest `dexie` block) back the pipeline's products:
 *  - `topics`   — candidate selections produced by the front workflow.
 *  - `research` — research notes gathered for a chosen topic.
 *  - `drafts`   — final answer drafts saved by the writing crew.
 *
 * Pure row builders + a tolerant candidate parser keep the logic unit-testable
 * without IndexedDB; `createPipelineDb(dexie)` wraps a live `PluginDexieAPI`
 * (the handle captured in `activate()`) for the custom node + plugin tools that
 * actually persist — agents can't reach `ctx.dexie` directly, so they go
 * through the `zhihu_save_*` tools, and the workflow's save-topics node closes
 * over this same handle.
 */

import type { PluginDexieAPI } from "@cognia/plugin-sdk"
export type TopicStatus = "candidate" | "selected" | "done"
export type DraftStatus = "draft" | "published"

export interface TopicRow {
  id: string
  title: string
  url?: string
  source: string
  /** Why it's trending / worth writing — the scout's evidence. */
  reason?: string
  /** Heuristic 0-100 score from the ranking step. */
  score?: number
  status: TopicStatus
  createdAt: number
}

export interface ResearchRow {
  id: string
  topicId?: string
  /** e.g. "fact", "case", "data", "source". */
  kind: string
  content: string
  sourceUrl?: string
  createdAt: number
}

export interface DraftRow {
  id: string
  topicId?: string
  title: string
  markdownBody: string
  /** Illustration file paths or source URLs. */
  images: string[]
  status: DraftStatus
  createdAt: number
}

/** Table names without the `<pluginId>:` prefix (the API adds it). */
export const TABLES = { topics: "topics", research: "research", drafts: "drafts" } as const

/** Generate a sortable-ish unique id without depending on crypto.randomUUID. */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Shape the front workflow's ranking step emits per candidate. */
export interface CandidateInput {
  title: string
  url?: string
  reason?: string
  score?: number
}

/**
 * Tolerantly parse the ranking step's output into candidates. Accepts a raw
 * JSON array, a `{ candidates: [...] }` / `{ topics: [...] }` wrapper, or a
 * fenced ```json block embedded in prose. Drops entries without a title.
 * Never throws — bad input yields an empty list so the node logs and no-ops.
 */
export function parseCandidates(input: unknown): CandidateInput[] {
  let text = typeof input === "string" ? input.trim() : ""
  if (!text && input && typeof input === "object") {
    // Already-parsed object/array passed straight through.
    return normalizeCandidates(input)
  }
  if (!text) return []
  // Pull the first fenced ```json block if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  try {
    return normalizeCandidates(JSON.parse(text))
  } catch {
    return []
  }
}

/**
 * Like {@link parseCandidates}, but distinguishes "upstream gave us nothing"
 * from "upstream gave us something we could not parse".
 *
 * Collapsing the two into `[]` meant a model that answered with prose (or the
 * `ai.prompt` stub echo) produced `{ saved: 0 }` and a SUCCESSFUL step — the
 * daily pipeline ran green and wrote nothing, indefinitely.
 */
export function parseCandidatesStrict(input: unknown): {
  candidates: CandidateInput[]
  unparseable: boolean
} {
  const candidates = parseCandidates(input)
  // Only a NON-EMPTY STRING that yields nothing is a parse failure — that is
  // the prose / stub-echo case. An array or object input is already structured
  // data, so an empty result there is a legitimate "no candidates" answer and
  // must not fail the step.
  const unparseable =
    typeof input === "string" && input.trim().length > 0 && candidates.length === 0
  return { candidates, unparseable }
}

function normalizeCandidates(parsed: unknown): CandidateInput[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { candidates?: unknown[] })?.candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : Array.isArray((parsed as { topics?: unknown[] })?.topics)
        ? (parsed as { topics: unknown[] }).topics
        : []
  const out: CandidateInput[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const title = typeof r.title === "string" ? r.title.trim() : ""
    if (!title) continue
    const score = typeof r.score === "number" ? r.score : Number(r.score)
    out.push({
      title,
      url: typeof r.url === "string" ? r.url : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
      score: Number.isFinite(score) ? score : undefined,
    })
  }
  return out
}

/** Build a candidate topic row from a parsed candidate. */
export function buildTopicRow(c: CandidateInput, source: string): TopicRow {
  return {
    id: genId("topic"),
    title: c.title,
    url: c.url,
    source,
    reason: c.reason,
    score: c.score,
    status: "candidate",
    createdAt: Date.now(),
  }
}

/** Typed accessor over the plugin's three tables. */
export interface PipelineDb {
  saveTopics(candidates: CandidateInput[], source: string): Promise<TopicRow[]>
  listTopics(status?: TopicStatus): Promise<TopicRow[]>
  setTopicStatus(id: string, status: TopicStatus): Promise<void>
  saveResearch(row: Omit<ResearchRow, "id" | "createdAt">): Promise<ResearchRow>
  saveDraft(
    row: Omit<DraftRow, "id" | "createdAt" | "status"> & { status?: DraftStatus }
  ): Promise<DraftRow>
  listDrafts(): Promise<DraftRow[]>
}

/** Wrap a live PluginDexieAPI into the typed pipeline DAO. */
export function createPipelineDb(dexie: PluginDexieAPI): PipelineDb {
  const topics = () => dexie.table<TopicRow, string>(TABLES.topics)
  const research = () => dexie.table<ResearchRow, string>(TABLES.research)
  const drafts = () => dexie.table<DraftRow, string>(TABLES.drafts)

  return {
    async saveTopics(candidates, source) {
      const rows = candidates.map((c) => buildTopicRow(c, source))
      if (rows.length > 0) await topics().bulkPut(rows)
      return rows
    },
    async listTopics(status) {
      const all = await topics().toArray()
      const filtered = status ? all.filter((t) => t.status === status) : all
      return filtered.sort((a, b) => b.createdAt - a.createdAt)
    },
    async setTopicStatus(id, status) {
      await topics().update(id, { status })
    },
    async saveResearch(row) {
      const full: ResearchRow = { ...row, id: genId("research"), createdAt: Date.now() }
      await research().put(full)
      return full
    },
    async saveDraft(row) {
      const full: DraftRow = {
        ...row,
        images: row.images ?? [],
        status: row.status ?? "draft",
        id: genId("draft"),
        createdAt: Date.now(),
      }
      await drafts().put(full)
      return full
    },
    async listDrafts() {
      const all = await drafts().toArray()
      return all.sort((a, b) => b.createdAt - a.createdAt)
    },
  }
}
