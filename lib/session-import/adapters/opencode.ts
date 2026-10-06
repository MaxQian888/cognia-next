// OpenCode session-history source.
//
// The record format itself is read by `@cognia/agent-opencode/history`
// (ADR-0217): this module owns only what the host decides. Current OpenCode
// persists to SQLite (`~/.local/share/opencode/opencode.db`), which the host
// reads through `opencode-db.ts` (the Rust `opencode_sessions_read` command on
// desktop, `node:sqlite` in the CLI) into normalized sessions; the picker
// fallback accepts an OpenCode share export. This module owns where those
// live, how one import run caches the read, and how a parsed session becomes
// app rows, a nested subagent tree and an imported session graph.

import type { ImportedConversation } from "@/lib/data/importers/types"
import {
  detectOpencodeExport,
  OPENCODE_HISTORY_FORMAT,
  opencodeSessionRevision,
  opencodeSessionTree,
  parseOpencodeExport,
  readOpencodeSession,
  type OpencodeSession,
} from "@cognia/agent-opencode/history"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored } from "../history-to-stored"
import { buildSession, importedSessionId } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"
import { opencodeDataDirs, readOpencodeSessions } from "./opencode-db"

export { parseOpencodeExport }

export function opencodeToConversation(
  session: OpencodeSession,
  projectId?: string
): ImportedConversation {
  const parsed = readOpencodeSession(session)
  const id = importedSessionId(parsed.sourceId, parsed.originalSessionId)
  const messages = historyMessagesToStored(id, parsed.messages, projectId)
  const built = buildSession({
    id,
    projectId,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: messages,
    ...(parsed.parentNativeSessionId ? { kind: "subagent" } : {}),
    suppressSeed: parsed.parentNativeSessionId !== undefined,
  })
  if (parsed.parentNativeSessionId) {
    built.parentSessionId = importedSessionId(parsed.sourceId, parsed.parentNativeSessionId)
    built.importRelation = {
      kind: "subagent",
      parentNativeSessionId: parsed.parentNativeSessionId,
    }
  }
  return { session: built, messages }
}

function summarize(
  session: OpencodeSession,
  descendants: OpencodeSession[],
  updatedAt = session.updatedAt
): SessionSummary {
  return {
    ref: { sourceId: "opencode", originalSessionId: session.id, locator: session.id },
    title: session.title,
    sourceId: "opencode",
    messageCount: session.messages.length,
    updatedAt,
    watchRevision: opencodeSessionRevision(session, descendants),
    cwd: session.cwd,
  }
}

// One import run reuses the same `SessionScanInput` object for every ref, so a
// per-input cache turns the previous O(selected sessions × full-DB read) into a
// single DB read per run. Keyed weakly: a fresh scan builds a fresh input, so
// there is no staleness across runs and no explicit invalidation needed.
interface SessionIndex {
  sessions: OpencodeSession[]
  firstById: Map<string, OpencodeSession>
  lastById: Map<string, OpencodeSession>
  childrenByParent: Map<string, OpencodeSession[]>
}

const sessionCache = new WeakMap<SessionScanInput, Promise<SessionIndex>>()

async function collectSessions(input: SessionScanInput): Promise<SessionIndex> {
  const cached = sessionCache.get(input)
  if (cached) return cached
  const promise = input.pickedFiles?.length
    ? Promise.resolve(
        input.pickedFiles
          .filter((f) => f.name.toLowerCase().endsWith(".json"))
          .flatMap((f) => parseOpencodeExport(f.content))
      )
    : readOpencodeSessions(input.home)
  // Evict a FAILED read so the next attempt actually retries. A rejected promise
  // left in the cache would make one locked-database moment poison every later
  // scan that happens to reuse this input.
  const guarded = promise
    .then((sessions): SessionIndex => {
      const firstById = new Map<string, OpencodeSession>()
      const lastById = new Map<string, OpencodeSession>()
      const childrenByParent = new Map<string, OpencodeSession[]>()
      for (const session of sessions) {
        // Conversation lookup historically uses find (first), while graph
        // structured state uses Map construction (last). Keep both on duplicates.
        if (!firstById.has(session.id)) firstById.set(session.id, session)
        lastById.set(session.id, session)
        if (session.messages.length === 0 || !session.parentId) continue
        const children = childrenByParent.get(session.parentId) ?? []
        children.push(session)
        childrenByParent.set(session.parentId, children)
      }
      return { sessions, firstById, lastById, childrenByParent }
    })
    .catch((error: unknown) => {
      sessionCache.delete(input)
      throw error
    })
  sessionCache.set(input, guarded)
  return guarded
}

import { opencodeCodec } from "@/lib/session-import/codecs/opencode-codec"

export const opencodeSessionSource: AgentSessionSourceAdapter = {
  codec: opencodeCodec,
  id: "opencode",
  displayName: "OpenCode",
  labelKey: "opencode",
  verifiedVersion: OPENCODE_HISTORY_FORMAT.verifiedVersion,
  verifiedAt: OPENCODE_HISTORY_FORMAT.verifiedAt,
  acceptedExtensions: [...OPENCODE_HISTORY_FORMAT.acceptedExtensions],

  // The scan itself goes through the Rust SQLite reader (keyed by home), not a
  // dir walk — but the roots still matter: they feed the fs-watcher
  // (`collectWatchRoots`), and the watcher already recognizes `.db` files. An
  // empty list here meant OpenCode never got incremental re-imports.
  scanRoots(home, roots) {
    return opencodeDataDirs(home, roots?.opencodeDataDir, roots?.opencodePlatformDataDir)
  },

  detect(files: PickedSessionFile[]) {
    return detectOpencodeExport(files)
  },

  async listSessions(input: SessionScanInput) {
    const { sessions } = await collectSessions(input)
    const tree = opencodeSessionTree(sessions)
    return tree.roots
      .map((session) => {
        const descendants = tree.descendantsOf(session.id)
        const updatedAt = descendants.reduce(
          (newest, descendant) => Math.max(newest, descendant.updatedAt),
          session.updatedAt
        )
        return summarize(session, descendants, updatedAt)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    const { firstById, childrenByParent } = await collectSessions(input)
    const found = firstById.get(ref.originalSessionId)
    if (!found) {
      // Empty shell rather than throwing — keeps a multi-import batch resilient.
      return opencodeToConversation({
        id: ref.originalSessionId,
        title: "OpenCode session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      })
    }
    const buildTree = (session: OpencodeSession, seen: Set<string>): ImportedConversation => {
      const conversation = opencodeToConversation(session)
      if (seen.has(session.id)) return conversation
      const nextSeen = new Set(seen).add(session.id)
      const nested = (childrenByParent.get(session.id) ?? [])
        .filter((child) => !nextSeen.has(child.id))
        .map((child) => buildTree(child, nextSeen))
      if (nested.length > 0) conversation.nested = nested
      return conversation
    }
    return buildTree(found, new Set())
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const { lastById } = await collectSessions(input)
    const graph = buildImportedSessionGraph(await this.parseSession(ref, input), {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    for (const node of graph.nodes) {
      const nativeId = node.conversation.session.id.replace(/^import:opencode:/, "")
      const native = lastById.get(nativeId)
      if (!native) continue
      const state = readOpencodeSession(native)
      if (state.tasks.length > 0) node.session.tasks = state.tasks
      if (state.history.length > 0) node.session.history = state.history
      if (state.recordedEvents.length > 0) node.session.recordedEvents = state.recordedEvents
      node.loss.losses.push(...state.losses.map((loss) => ({ ...loss })))
    }
    return graph
  },
}
