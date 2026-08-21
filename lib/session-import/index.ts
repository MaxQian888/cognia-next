// Public surface for the external-agent session-history import subsystem.
// See ADR-0062.

import { applyImported } from "@/lib/data/import-registry"
import type { ImportedConversation } from "@/lib/data/importers/types"
import { resolveHome } from "@/lib/memory/external/home"
import { resolveVendorRoots } from "@/lib/agent-roots"
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
  detectSourcesForFiles,
  detectSourceForPath,
  getAcceptedPickerExtensions,
  getPickerOnlySources,
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

/**
 * Build the scan input, resolving the real fs + home + vendor roots unless
 * overridden. The roots carry `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` / `$XDG_*`
 * (see `lib/agent-roots/`), which the renderer cannot read on its own.
 */
export async function resolveScanInput(
  partial: Partial<SessionScanInput> = {}
): Promise<SessionScanInput> {
  const fs = partial.fs ?? realSessionFs()
  const home = partial.home ?? (await resolveHome()) ?? ""
  const roots = partial.roots ?? (await resolveVendorRoots())
  return { fs, home, roots, pickedFiles: partial.pickedFiles }
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
): Promise<{ conversations: ImportedConversation[]; parsed: boolean }> {
  const source = getSessionSource(ref.sourceId)
  if (!source) return { conversations: [], parsed: false }
  try {
    const conv = await source.parseSession(ref, input)
    const nested = conv.nested ?? []
    // Stamp the originating adapter id. The session id encodes it, but a plugin
    // source id may itself contain a colon, so `import:<source>:<originalId>`
    // cannot be parsed back apart — and the UI needs to name the agent a
    // conversation came from.
    conv.session.importSource = source.id
    conv.session.importSourceLabel = source.displayName
    for (const n of nested) {
      n.session.importSource = source.id
      n.session.importSourceLabel = source.displayName
    }
    if (projectId) {
      conv.session.projectId = projectId
      for (const m of conv.messages) m.projectId = projectId
      for (const n of nested) {
        n.session.projectId = projectId
        for (const m of n.messages) m.projectId = projectId
      }
    }
    if (conv.messages.length === 0) return { conversations: [], parsed: true }
    return {
      conversations: [{ session: conv.session, messages: conv.messages }, ...nested],
      parsed: true,
    }
  } catch {
    // Skip a session that fails to parse.
    return { conversations: [], parsed: false }
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
    const parsed = await parseRefConversations(ref, input, projectId)
    conversations.push(...parsed.conversations)
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
/**
 * Best-effort canonical projection (ADR-0090 Phase 8): convert the imported
 * conversation through the source's codec, persist the HEADER row, and fold
 * the loss report into the per-source aggregate. Never fails the import.
 */
async function projectCanonical(
  codec: NonNullable<import("./codec-types").SessionCodec>,
  conversation: ImportedConversation,
  aggregate: Record<
    string,
    import("@cognia/agent-config-types/canonical-session").SessionLossReport
  >,
  sourceId: string
): Promise<void> {
  try {
    const { session, loss } = codec.toCanonical(conversation)
    const bucket = (aggregate[sourceId] ??= { fidelity: loss.fidelity, losses: [] })
    bucket.losses.push(...loss.losses)
    const { headerRowFromCanonical, putCanonicalSessionHeader } =
      await import("@/lib/db/agent-canonical-sessions")
    await putCanonicalSessionHeader(headerRowFromCanonical(session, loss))
  } catch {
    // Projection is an index over the import — never the import itself.
  }
}

export async function importSessions(
  refs: SessionRef[],
  input: SessionScanInput,
  projectId?: string,
  opts: ImportOptions = {}
): Promise<{
  sessions: number
  messages: number
  /** Per-source conversion fidelity of THIS import (codec-declaring sources only). */
  lossBySource: Record<
    string,
    import("@cognia/agent-config-types/canonical-session").SessionLossReport
  >
}> {
  const { signal, onProgress, onRefParsed, chunkSize = DEFAULT_IMPORT_CHUNK } = opts
  const total = refs.length
  const size = Math.max(1, chunkSize)

  let sessions = 0
  let messages = 0
  let buffer: ImportedConversation[] = []
  let parsed = 0
  let flushed = 0
  const lossBySource: Record<
    string,
    import("@cognia/agent-config-types/canonical-session").SessionLossReport
  > = {}

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
    const parsedRef = await parseRefConversations(ref, input, projectId)
    const conversations = parsedRef.conversations
    buffer.push(...conversations)
    if (parsedRef.parsed) onRefParsed?.(ref)
    // Canonical header projection (top-level conversation only; nested
    // subagent transcripts are the parent's loss entry, not headers).
    const codec = getSessionSource(ref.sourceId)?.codec
    if (codec && conversations[0]) {
      await projectCanonical(codec, conversations[0], lossBySource, ref.sourceId)
    }
    parsed += 1
    onProgress?.({ phase: "parsing", done: parsed, total })
    // Chunk by refs (not conversations) so a session with many nested subagents
    // still flushes on schedule rather than ballooning one transaction.
    if (parsed - flushed >= size) await flush()
  }
  // Persist whatever is buffered — including partial work when aborted.
  await flush()
  return { sessions, messages, lossBySource }
}
