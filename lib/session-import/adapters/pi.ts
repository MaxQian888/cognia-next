/**
 * Pi session-history source (ADR-0119, ADR-0062).
 *
 * The session format itself (a JSONL tree in three versions) is read by
 * `@cognia/agent-pi/history` (ADR-0217): this module owns only what the host
 * decides — where sessions live (`~/.pi/agent/sessions`, or the directory Rust
 * resolved from `$PI_CODING_AGENT_SESSION_DIR` / `$PI_CODING_AGENT_DIR`), how
 * the files are read, and how a parsed file becomes app rows: the active
 * transcript as the session, every alternate leaf as a nested branch
 * conversation, the `pi-rpc` resume binding, and the imported session graph.
 */

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { SessionLossEntry } from "@cognia/agent-config-types/canonical-session"
import type { ParsedHistorySession } from "@cognia/agent-contracts/history"
import {
  detectPiSession,
  parsePiSessionFile,
  PI_HISTORY_FORMAT,
  readPiSession,
  summarizePiSession,
} from "@cognia/agent-pi/history"
import { joinPath } from "@/lib/claude/instructions/paths"
import { scanFileSummaries } from "../scan"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored, historySummaryToSessionSummary } from "../history-to-stored"
import { buildSession, importedSessionId } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionDetectVerdict,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"
import { piCodec } from "../codecs/pi-codec"

export const PI_SOURCE_ID = PI_HISTORY_FORMAT.sourceId

export { parsePiSessionFile }

/** Cheap single-pass summary for the scan list (no message allocation). */
export function summarizePiFile(content: string, locator: string): SessionSummary | null {
  const summary = summarizePiSession(content, locator)
  return summary ? historySummaryToSessionSummary(summary, locator) : null
}

async function readFile(input: SessionScanInput, locator: string): Promise<string> {
  const picked = input.pickedFiles?.find((file) => file.path === locator)
  if (picked) return picked.content
  return input.fs.readTextFile(locator)
}

function piResumeBinding(parsed: ParsedHistorySession) {
  return {
    presetId: "pi-rpc",
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
    resumeMethod: "api" as const,
    verifiedAt: piSessionSource.verifiedAt,
  }
}

/** One parsed Pi file as conversations, plus each conversation's losses by session id. */
function piConversation(
  ref: SessionRef,
  content: string
): { conversation: ImportedConversation; losses: Map<string, SessionLossEntry[]> } {
  const read = readPiSession(content, ref.originalSessionId)
  const main = read.session
  const sessionId = importedSessionId(PI_SOURCE_ID, main.originalSessionId)
  const losses = new Map<string, SessionLossEntry[]>([[sessionId, main.losses]])

  const messages = historyMessagesToStored(sessionId, main.messages)
  const session = buildSession({
    id: sessionId,
    title: main.title,
    ...(main.model ? { model: main.model } : {}),
    ...(main.cwd ? { workingDir: main.cwd } : {}),
    createdAt: main.createdAt,
    updatedAt: main.updatedAt,
    seedMessages: messages,
  })
  session.importRuntimeBinding = piResumeBinding(main)
  if (main.relationKind === "fork") {
    session.importRelation = {
      kind: "fork",
      ...(main.parentNativeSessionId ? { parentNativeSessionId: main.parentNativeSessionId } : {}),
    }
  }

  // Alternate leaves are branches the user can still reach in Pi's `/tree`.
  // They import as nested conversations rather than being discarded.
  const nested: ImportedConversation[] = []
  for (const branch of read.branches) {
    const branchSessionId = `${sessionId}:branch:${branch.leafId}`
    const branchMessages = historyMessagesToStored(branchSessionId, branch.session.messages)
    const branchSession = buildSession({
      id: branchSessionId,
      title: branch.session.title,
      ...(branch.session.model ? { model: branch.session.model } : {}),
      ...(branch.session.cwd ? { workingDir: branch.session.cwd } : {}),
      createdAt: branch.session.createdAt,
      updatedAt: branch.session.updatedAt,
      seedMessages: branchMessages,
    })
    branchSession.parentSessionId = sessionId
    branchSession.importRelation = {
      kind: "branch",
      parentNativeSessionId: main.originalSessionId,
    }
    branchSession.importRuntimeBinding = piResumeBinding(branch.session)
    nested.push({ session: branchSession, messages: branchMessages })
    losses.set(branchSessionId, branch.session.losses)
  }

  return {
    conversation: { session, messages, ...(nested.length > 0 ? { nested } : {}) },
    losses,
  }
}

export function parsePiSession(ref: SessionRef, content: string): ImportedConversation {
  return piConversation(ref, content).conversation
}

export const piSessionSource: AgentSessionSourceAdapter = {
  id: PI_SOURCE_ID,
  displayName: "Pi",
  labelKey: "pi",
  verifiedVersion: PI_HISTORY_FORMAT.verifiedVersion,
  verifiedAt: PI_HISTORY_FORMAT.verifiedAt,
  acceptedExtensions: [...PI_HISTORY_FORMAT.acceptedExtensions],

  scanRoots(home, roots) {
    // `piSessionDir` already folds in both `$PI_CODING_AGENT_SESSION_DIR` and
    // `$PI_CODING_AGENT_DIR` (sessions hang off the agent dir), resolved in
    // Rust where the environment is actually visible. The home-relative
    // fallback is only for web mode / tests, which have no IPC.
    const sessions = roots?.piSessionDir || (home ? joinPath(home, ".pi/agent/sessions") : "")
    return sessions ? [sessions] : []
  },

  detect(files: PickedSessionFile[]): SessionDetectVerdict {
    return detectPiSession(files)
  },

  async listSessions(input: SessionScanInput): Promise<SessionSummary[]> {
    return scanFileSummaries(
      input,
      this.scanRoots(input.home, input.roots),
      (path) => path.endsWith(".jsonl"),
      summarizePiFile
    )
  },

  async parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation> {
    return parsePiSession(ref, await readFile(input, ref.locator))
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const { conversation, losses } = piConversation(ref, await readFile(input, ref.locator))
    const graph = buildImportedSessionGraph(conversation, {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    for (const node of graph.nodes) {
      const nodeLosses = losses.get(node.conversation.session.id) ?? []
      node.loss.losses.push(...nodeLosses.map((loss) => ({ ...loss })))
    }
    return graph
  },

  summarizeFile: summarizePiFile,
  codec: piCodec,
}
