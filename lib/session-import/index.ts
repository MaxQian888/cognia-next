// Public surface for the external-agent session-history import subsystem.
// See ADR-0062.

import { applyImported } from "@/lib/data/import-registry"
import type { ImportedConversation } from "@/lib/data/importers/types"
import { resolveHome } from "@/lib/memory/external/home"
import { realSessionFs } from "./fs"
import { getSessionSource, getSessionSources } from "./registry"
import type { ImportOptions, SessionRef, SessionScanInput, SessionSummary } from "./types"

/**
 * Default number of sessions parsed+persisted per transaction. Bounds peak
 * memory and transaction size for a large "import everything" run, instead of
 * buffering the whole selection and writing it in one giant `rw` transaction.
 */
export const DEFAULT_IMPORT_CHUNK = 25

export {
  registerSessionSource,
  unregisterSessionSourcesByPlugin,
  getSessionSources,
  getSessionSource,
  detectSourceForFiles,
  detectSourceForPath,
  getAcceptedPickerExtensions,
  __resetDynamicSessionSourcesForTesting,
} from "./registry"
export { realSessionFs, walkFiles } from "./fs"
export type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionFs,
  SessionRef,
  SessionScanInput,
  SessionSummary,
  ImportedConversation,
  ImportOptions,
  ImportPhase,
  ImportProgress,
} from "./types"

/** Build the scan input, resolving the real fs + home unless overridden. */
export async function resolveScanInput(
  partial: Partial<SessionScanInput> = {}
): Promise<SessionScanInput> {
  const fs = partial.fs ?? realSessionFs()
  const home = partial.home ?? (await resolveHome()) ?? ""
  return { fs, home, pickedFiles: partial.pickedFiles }
}

/** List sessions for one source. Returns [] for an unknown source id. */
export async function listSessionsForSource(
  sourceId: string,
  input: SessionScanInput
): Promise<SessionSummary[]> {
  const source = getSessionSource(sourceId)
  if (!source) return []
  return source.listSessions(input)
}

/** A source that threw during a scan, surfaced instead of silently swallowed. */
export interface SessionScanError {
  sourceId: string
  message: string
}

/**
 * Scan every registered source, returning the summaries AND the per-source
 * failures (a failing source must not sink the whole scan, but the user should
 * still see that e.g. OpenCode's DB couldn't be read).
 */
export async function scanAllSources(
  input: SessionScanInput
): Promise<{ summaries: SessionSummary[]; errors: SessionScanError[] }> {
  const summaries: SessionSummary[] = []
  const errors: SessionScanError[] = []
  for (const source of getSessionSources()) {
    try {
      summaries.push(...(await source.listSessions(input)))
    } catch (err) {
      errors.push({
        sourceId: source.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return { summaries, errors }
}

/** List sessions across every registered source (scan mode). */
export async function listAllSessions(input: SessionScanInput): Promise<SessionSummary[]> {
  return (await scanAllSources(input)).summaries
}

/**
 * Parse ONE ref to its top-level conversations: the main thread plus any nested
 * subagent transcripts (ADR-0062), each stamped with `projectId`. Returns [] for
 * an unknown source, a parse failure, or an empty transcript.
 */
async function parseRefConversations(
  ref: SessionRef,
  input: SessionScanInput,
  projectId?: string
): Promise<ImportedConversation[]> {
  const source = getSessionSource(ref.sourceId)
  if (!source) return []
  try {
    const conv = await source.parseSession(ref, input)
    const nested = conv.nested ?? []
    if (projectId) {
      conv.session.projectId = projectId
      for (const m of conv.messages) m.projectId = projectId
      for (const n of nested) {
        n.session.projectId = projectId
        for (const m of n.messages) m.projectId = projectId
      }
    }
    if (conv.messages.length === 0) return []
    return [{ session: conv.session, messages: conv.messages }, ...nested]
  } catch {
    // Skip a session that fails to parse.
    return []
  }
}

/**
 * Parse the given session refs to conversations. `projectId` stamps the active
 * workspace onto every imported session/message. Failing refs are skipped.
 */
export async function parseSessions(
  refs: SessionRef[],
  input: SessionScanInput,
  projectId?: string
): Promise<ImportedConversation[]> {
  const conversations: ImportedConversation[] = []
  for (const ref of refs) {
    conversations.push(...(await parseRefConversations(ref, input, projectId)))
  }
  return conversations
}

/**
 * Parse + persist, streamed. Parses one ref at a time and flushes to Dexie every
 * `chunkSize` sessions (default {@link DEFAULT_IMPORT_CHUNK}) so a large "import
 * everything" run never buffers the whole selection nor writes it in one giant
 * transaction. Reports `parsing`/`writing` progress and honors an `AbortSignal`
 * between refs and before each flush — aborting keeps the work already persisted
 * (ids are idempotent + merge-guarded). Returns the total counts written.
 */
export async function importSessions(
  refs: SessionRef[],
  input: SessionScanInput,
  projectId?: string,
  opts: ImportOptions = {}
): Promise<{ sessions: number; messages: number }> {
  const { signal, onProgress, chunkSize = DEFAULT_IMPORT_CHUNK } = opts
  const total = refs.length
  const size = Math.max(1, chunkSize)

  let sessions = 0
  let messages = 0
  let buffer: ImportedConversation[] = []
  let parsed = 0
  let flushed = 0

  const flush = async () => {
    if (buffer.length === 0) return
    const counts = await applyImported(buffer)
    sessions += counts.sessions
    messages += counts.messages
    buffer = []
    flushed = parsed
    onProgress?.({ phase: "writing", done: flushed, total })
  }

  for (const ref of refs) {
    if (signal?.aborted) break
    buffer.push(...(await parseRefConversations(ref, input, projectId)))
    parsed += 1
    onProgress?.({ phase: "parsing", done: parsed, total })
    // Chunk by refs (not conversations) so a session with many nested subagents
    // still flushes on schedule rather than ballooning one transaction.
    if (parsed - flushed >= size) await flush()
  }
  // Persist whatever is buffered — including partial work when aborted.
  await flush()
  return { sessions, messages }
}
