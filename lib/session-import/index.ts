// Public surface for the external-agent session-history import subsystem.
// See ADR-0062.

import { applyImported } from "@/lib/data/import-registry"
import type { ImportedConversation } from "@/lib/data/importers/types"
import { resolveHome } from "@/lib/memory/external/home"
import { resolveVendorRoots } from "@/lib/agent-roots"
import { realSessionFs } from "./fs"
import { buildImportedSessionGraph } from "./graph"
import { getSessionSource, getSessionSources } from "./registry"
import type {
  ImportedSessionGraphNode,
  ImportOptions,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "./types"
import type {
  CanonicalSessionLifecycleStatus,
  CanonicalSession,
} from "@cognia/agent-config-types/canonical-session"

/**
 * Default number of sessions parsed+persisted per transaction. Bounds peak
 * memory and transaction size for a large "import everything" run, instead of
 * buffering the whole selection and writing it in one giant `rw` transaction.
 */
export const DEFAULT_IMPORT_CHUNK = 25

function attachedStatusFromLifecycle(
  status: CanonicalSessionLifecycleStatus | undefined
): "staged" | "running" | "completed" | "interrupted" {
  if (status === "running") return "running"
  if (status === "completed") return "completed"
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return "interrupted"
  }
  return "staged"
}

function canonicalStateFromSession(
  session: CanonicalSession
): NonNullable<ImportedConversation["session"]["importCanonicalState"]> {
  return {
    ...(session.permissions ? { permissions: session.permissions } : {}),
    ...(session.checkpoints ? { checkpoints: session.checkpoints } : {}),
    ...(session.tasks ? { tasks: session.tasks } : {}),
    ...(session.plans ? { plans: session.plans } : {}),
    ...(session.goals ? { goals: session.goals } : {}),
    ...(session.history ? { history: session.history } : {}),
    ...(session.interAgentMessages ? { interAgentMessages: session.interAgentMessages } : {}),
    ...(session.recordedEvents ? { recordedEvents: session.recordedEvents } : {}),
  }
}

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
export { buildExternalSessionSupportMatrix } from "./support-matrix"
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
  ImportedSessionGraph,
  ImportedSessionGraphNode,
  SessionImportDetail,
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
): Promise<{
  conversations: ImportedConversation[]
  canonicalNodes: ImportedSessionGraphNode[]
  parsed: boolean
}> {
  const source = getSessionSource(ref.sourceId)
  if (!source) return { conversations: [], canonicalNodes: [], parsed: false }
  try {
    const richGraph = source.parseGraph ? await source.parseGraph(ref, input) : undefined
    const conv = richGraph ? undefined : await source.parseSession(ref, input)
    const legacyGraph = conv
      ? buildImportedSessionGraph(conv, {
          sourceRuntime: source.id,
          sourceVersion: source.verifiedVersion,
          verifiedAt: source.verifiedAt,
          // Read only when there is no codec — and a source with no codec has
          // no declared fidelity either, so this is always "summary-only".
          // The one intended downgrade for a legacy `parseSession` adapter is
          // applied once, per node, on `node.loss.fidelity` just below;
          // re-deriving it here decided nothing and risked downgrading twice.
          importFidelity: source.codec?.importFidelity ?? "summary-only",
          codec: source.codec,
        })
      : undefined
    if (legacyGraph) {
      for (const node of legacyGraph.nodes) {
        const fidelity =
          node.loss.fidelity === "native-exact"
            ? "structured"
            : node.loss.fidelity === "structured"
              ? "contextual"
              : node.loss.fidelity === "contextual"
                ? "summary-only"
                : node.loss.fidelity
        node.loss.fidelity = fidelity
        node.session.header.importFidelity = fidelity
        node.loss.losses.push({
          path: "graph.relationships",
          kind: "summarized",
          detail: "Legacy parseSession adapter does not expose a source session graph.",
        })
      }
    }
    const graph = richGraph ?? legacyGraph
    const conversations = graph?.nodes.map((node) => node.conversation) ?? []
    const canonicalNodes = graph?.nodes ?? []
    const canonicalSessionIds = new Map(
      canonicalNodes.map((node) => [
        node.session.header.canonicalSessionId,
        node.conversation.session.id,
      ])
    )
    const graphRootSessionId = graph
      ? canonicalSessionIds.get(graph.rootCanonicalSessionId)
      : undefined
    // Stamp the originating adapter id. The session id encodes it, but a plugin
    // source id may itself contain a colon, so `import:<source>:<originalId>`
    // cannot be parsed back apart — and the UI needs to name the agent a
    // conversation came from.
    for (const conversation of conversations) {
      conversation.session.importSource = source.id
      conversation.session.importSourceLabel = source.displayName
      conversation.session.importOwnership ??= "source-mirror"
      if (graph?.sourceVersion) conversation.session.importSourceVersion = graph.sourceVersion
      if (graph?.sourceRevision) conversation.session.importSourceRevision = graph.sourceRevision
      if (graphRootSessionId) conversation.session.importGraphRootId = graphRootSessionId
      if (projectId) {
        conversation.session.projectId = projectId
      }
      for (const message of conversation.messages) {
        if (projectId) message.projectId = projectId
        message.metadata = { ...message.metadata, importSourceOwned: true }
      }
    }

    for (const node of canonicalNodes) {
      const { header } = node.session
      const target = node.conversation.session
      if (header.runtimeBinding) target.importRuntimeBinding = header.runtimeBinding
      target.importCanonicalState = canonicalStateFromSession(node.session)
      target.importLossReport = node.loss
      if (header.lineage) {
        target.importRelation = header.lineage
        const parentId = header.lineage.parentCanonicalSessionId
          ? canonicalSessionIds.get(header.lineage.parentCanonicalSessionId)
          : undefined
        if (parentId) target.parentSessionId = parentId
        if (header.lineage.kind === "subagent") target.kind = "subagent"
        if (
          parentId &&
          (header.lineage.kind === "background" || header.lineage.kind === "team-member")
        ) {
          const lifecycle = header.lifecycle
          const task = header.lineage.taskId
            ? node.session.tasks?.find((candidate) => candidate.taskId === header.lineage?.taskId)
            : node.session.tasks?.find((candidate) => candidate.summary)
          const createdAt = Date.parse(lifecycle?.startedAt ?? header.createdAt) || Date.now()
          const updatedAt =
            Date.parse(lifecycle?.updatedAt ?? lifecycle?.endedAt ?? header.updatedAt) || createdAt
          const completedAt = Date.parse(lifecycle?.endedAt ?? header.updatedAt) || updatedAt
          target.attachedChild = {
            parentSessionId: parentId,
            lifecycleOwnerSessionId: parentId,
            context: { mode: "none" },
            workspace: "shared",
            status: attachedStatusFromLifecycle(lifecycle?.status),
            createdAt,
            updatedAt,
            ...(task?.summary
              ? {
                  result: {
                    summary: task.summary,
                    completedAt,
                  },
                }
              : {}),
          }
          target.kind = "resource-workbench"
          target.visibility = "embedded"
          target.surfaceBinding = { kind: "session", sessionId: parentId }
        }
      }
      if (header.lifecycle) target.importLifecycle = header.lifecycle
    }

    // Graph nodes are meaningful even with no chat turns: a background task can
    // be pending/failed and carry only lifecycle/task/checkpoint state. Flat
    // legacy plugins keep the old empty-transcript filter.
    const importable = richGraph
      ? conversations
      : conversations.filter((conversation) => conversation.messages.length > 0)
    if (importable.length === 0) return { conversations: [], canonicalNodes, parsed: true }
    return {
      conversations: importable.map((conversation) => ({
        session: conversation.session,
        messages: conversation.messages,
      })),
      canonicalNodes,
      parsed: true,
    }
  } catch {
    // Skip a session that fails to parse.
    return { conversations: [], canonicalNodes: [], parsed: false }
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
  conversion: import("./codec-types").SessionCodecConversion,
  aggregate: Record<
    string,
    import("@cognia/agent-config-types/canonical-session").SessionLossReport
  >,
  sourceId: string
): Promise<void> {
  try {
    const { session, loss } = conversion
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
  /** Session-level provenance and fidelity; unlike lossBySource this preserves graph identity. */
  details: import("./types").SessionImportDetail[]
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
  const details: import("./types").SessionImportDetail[] = []

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
    const source = getSessionSource(ref.sourceId)
    if (parsedRef.canonicalNodes.length > 0) {
      for (const node of parsedRef.canonicalNodes) {
        await projectCanonical(node, lossBySource, ref.sourceId)
        const { header } = node.session
        details.push({
          sourceId: ref.sourceId,
          canonicalSessionId: header.canonicalSessionId,
          ...(header.title ? { title: header.title } : {}),
          ...(header.source?.version ? { sourceVersion: header.source.version } : {}),
          ...(header.source?.revision ? { sourceRevision: header.source.revision } : {}),
          ...(header.runtimeBinding ? { runtimeBinding: header.runtimeBinding } : {}),
          ...(header.lineage ? { lineage: header.lineage } : {}),
          ...(header.lifecycle ? { lifecycle: header.lifecycle } : {}),
          loss: node.loss,
        })
      }
    } else if (source?.codec) {
      for (const conversation of conversations) {
        const conversion = source.codec.toCanonical(conversation)
        await projectCanonical(conversion, lossBySource, ref.sourceId)
        const { header } = conversion.session
        details.push({
          sourceId: ref.sourceId,
          canonicalSessionId: header.canonicalSessionId,
          ...(header.title ? { title: header.title } : {}),
          ...(header.source?.version ? { sourceVersion: header.source.version } : {}),
          ...(header.source?.revision ? { sourceRevision: header.source.revision } : {}),
          ...(header.runtimeBinding ? { runtimeBinding: header.runtimeBinding } : {}),
          ...(header.lineage ? { lineage: header.lineage } : {}),
          ...(header.lifecycle ? { lifecycle: header.lifecycle } : {}),
          loss: conversion.loss,
        })
      }
    }
    parsed += 1
    onProgress?.({ phase: "parsing", done: parsed, total })
    // Chunk by refs (not conversations) so a session with many nested subagents
    // still flushes on schedule rather than ballooning one transaction.
    if (parsed - flushed >= size) await flush()
  }
  // Persist whatever is buffered — including partial work when aborted.
  await flush()
  return { sessions, messages, lossBySource, details }
}
