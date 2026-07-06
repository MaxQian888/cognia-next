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

/** List sessions across every registered source (scan mode). */
export async function listAllSessions(input: SessionScanInput): Promise<SessionSummary[]> {
  const out: SessionSummary[] = []
  for (const source of getSessionSources()) {
    try {
      out.push(...(await source.listSessions(input)))
    } catch {
      // A failing source must not sink the whole scan.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
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
      if (projectId) {
        conv.session.projectId = projectId
        for (const m of conv.messages) m.projectId = projectId
      }
      if (conv.messages.length > 0) conversations.push(conv)
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
