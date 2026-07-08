// Public surface for the external-agent session-history import subsystem.
// See ADR-0062.

import { applyImported } from "@/lib/data/import-registry"
import type { ImportedConversation } from "@/lib/data/importers/types"
import { resolveHome } from "@/lib/memory/external/home"
import { realSessionFs } from "./fs"
import { getSessionSource, getSessionSources } from "./registry"
import type { SessionRef, SessionScanInput, SessionSummary } from "./types"

export {
  registerSessionSource,
  unregisterSessionSourcesByPlugin,
  getSessionSources,
  getSessionSource,
  detectSourceForFiles,
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
    const source = getSessionSource(ref.sourceId)
    if (!source) continue
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
      if (conv.messages.length > 0) {
        // Persist the main conversation plus any nested subagent transcripts
        // (ADR-0062) as top-level rows in one pass.
        conversations.push({ session: conv.session, messages: conv.messages }, ...nested)
      }
    } catch {
      // Skip a session that fails to parse.
    }
  }
  return conversations
}

/** Parse + persist. Returns counts written to Dexie. */
export async function importSessions(
  refs: SessionRef[],
  input: SessionScanInput,
  projectId?: string
): Promise<{ sessions: number; messages: number }> {
  const conversations = await parseSessions(refs, input, projectId)
  return applyImported(conversations)
}
