// OpenAI Codex CLI session-history source.
//
// The rollout format itself is read by `@cognia/agent-codex/history`
// (ADR-0217): this module owns only what the host decides — where rollouts
// live (`<codexHome>/sessions/…`, with `codexHome` resolved in Rust and
// delivered through `SessionScanInput.roots`, because the renderer cannot read
// environment variables), how the corpus is read and budgeted, and how a
// parsed rollout becomes app rows and an imported session graph.

import { joinPath } from "@/lib/claude/instructions/paths"
import { presetIdsForSessionSource } from "@/lib/agent-ecosystem/runtime-link"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import { redactText } from "@cognia/redact"
import type { HistoryReaderHost, ParsedHistorySession } from "@cognia/agent-contracts/history"
import {
  CODEX_HISTORY_FORMAT,
  detectCodexRollouts,
  isCodexRolloutFileName,
  parseCodexRollout as readCodexRollout,
  summarizeCodexRollout,
} from "@cognia/agent-codex/history"
import { codexCodec } from "@/lib/session-import/codecs/codex-codec"
import { scanFileSummaries } from "../scan"
import { walkFiles } from "../fs"
import { everyBudget, mapBounded } from "../pacing"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored, historySummaryToSessionSummary } from "../history-to-stored"
import { buildSession, importedSessionId } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

/** A parsed rollout with its transcript already mapped to app rows. */
type ParsedSession = Omit<ParsedHistorySession, "messages"> & { messages: StoredMessage[] }

/** Diagnostics a reader keeps are passed through the app's PII redactor. */
const readerHost: HistoryReaderHost = { redactText: (text) => redactText(text).redacted }

export function parseCodexRollout(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const parsed = readCodexRollout(content, locatorId, readerHost)
  return {
    ...parsed,
    messages: historyMessagesToStored(
      importedSessionId(parsed.sourceId, parsed.originalSessionId),
      parsed.messages,
      projectId
    ),
  }
}

export function summarizeCodexFile(content: string, locator: string): SessionSummary | null {
  const summary = summarizeCodexRollout(content, locator)
  return summary ? historySummaryToSessionSummary(summary, locator) : null
}

function toConversation(parsed: ParsedSession, projectId?: string): ImportedConversation {
  const id = importedSessionId("codex", parsed.originalSessionId)
  const session = buildSession({
    id,
    projectId,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
    kind: parsed.relationKind === "subagent" ? "subagent" : "direct",
    suppressSeed: parsed.relationKind === "subagent",
  })
  session.importRuntimeBinding = {
    // The ecosystem's primary preset, from the runtime catalog; native resume
    // widens it to every runtime that reads the same session store.
    presetId: presetIdsForSessionSource(CODEX_HISTORY_FORMAT.sourceId)[0],
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
    resumeMethod: "cli",
    verifiedAt: codexSessionSource.verifiedAt,
  }
  if (parsed.relationKind && parsed.parentNativeSessionId) {
    session.parentSessionId = importedSessionId("codex", parsed.parentNativeSessionId)
    session.importRelation = {
      kind: parsed.relationKind,
      parentNativeSessionId: parsed.parentNativeSessionId,
    }
  }
  if (parsed.lifecycle) session.importLifecycle = parsed.lifecycle
  return { session, messages: parsed.messages }
}

async function readRolloutContent(ref: SessionRef, input: SessionScanInput): Promise<string> {
  if (input.pickedFiles?.length) {
    return input.pickedFiles.find((file) => file.path === ref.locator)?.content ?? ""
  }
  return input.fs.readTextFile(ref.locator)
}

async function scanCodexSummaries(input: SessionScanInput): Promise<SessionSummary[]> {
  return scanFileSummaries(
    input,
    codexSessionSource.scanRoots(input.home, input.roots),
    isCodexRolloutFileName,
    summarizeCodexFile
  )
}

/**
 * Locators of every rollout artifact in scope for `input` — the picked batch
 * when present, else every `.jsonl` under the Codex sessions root.
 */
async function codexArtifactLocators(input: SessionScanInput): Promise<string[]> {
  if (input.pickedFiles?.length) {
    return input.pickedFiles
      .filter((file) => isCodexRolloutFileName(file.name))
      .map((file) => file.path)
  }
  const locators: string[] = []
  for (const root of codexSessionSource.scanRoots(input.home, input.roots)) {
    locators.push(...(await walkFiles(input.fs, root, isCodexRolloutFileName)))
  }
  return locators
}

/**
 * In-flight rollout reads during the corpus pass — same IPC-latency overlap
 * as `SCAN_READ_LANES` in `scan.ts`, still bounded so buffered bodies stay
 * small.
 */
const CORPUS_READ_LANES = 8

async function collectCodexArtifacts(input: SessionScanInput): Promise<ParsedSession[]> {
  const locators = await codexArtifactLocators(input)
  const budget = everyBudget()
  const parsed = await mapBounded(locators, CORPUS_READ_LANES, async (locator) => {
    await budget()
    try {
      const candidate = parseCodexRollout(
        await readRolloutContent({ sourceId: "codex", originalSessionId: "", locator }, input),
        locator
      )
      // Mirror the old summarize-then-parse gate: a file with no importable
      // turns was never part of the artifact set.
      return candidate.messages.length > 0 ? candidate : null
    } catch {
      // One locked or concurrently-written rollout does not sink the graph.
      return null
    }
  })
  return parsed.filter((item): item is ParsedSession => item !== null)
}

/**
 * Whole-corpus parse, cached on the `SessionScanInput`. One import run reuses
 * the same input for every ref, so this turns the old O(refs × corpus)
 * re-scan+re-parse into a single pass per run — the difference between a
 * bounded import and a hard-frozen renderer on multi-GB histories. Keyed
 * weakly like `collectSessions` in `opencode.ts`: a fresh scan builds a fresh
 * input, so there is no staleness across runs and nothing to invalidate.
 */
interface CodexArtifactIndex {
  byId: Map<string, ParsedSession>
  children: Map<string, ParsedSession[]>
}

function indexCodexArtifacts(artifacts: ParsedSession[]): CodexArtifactIndex {
  const index: CodexArtifactIndex = { byId: new Map(), children: new Map() }
  for (const artifact of artifacts) addCodexArtifact(index, artifact)
  return index
}

function addCodexArtifact(index: CodexArtifactIndex, artifact: ParsedSession): void {
  // Last duplicate ID wins lookup, while every child artifact keeps its
  // original position. Retain orphan buckets so a late parent can attach them.
  index.byId.set(artifact.originalSessionId, artifact)
  if (artifact.parentNativeSessionId) {
    const siblings = index.children.get(artifact.parentNativeSessionId) ?? []
    siblings.push(artifact)
    index.children.set(artifact.parentNativeSessionId, siblings)
  }
}

const codexArtifactsCache = new WeakMap<SessionScanInput, Promise<CodexArtifactIndex>>()

function parseCodexArtifacts(input: SessionScanInput): Promise<CodexArtifactIndex> {
  const cached = codexArtifactsCache.get(input)
  if (cached) return cached
  // Evict a FAILED read so the next attempt actually retries — a rejected
  // promise left in the cache would poison every later ref on this input.
  const guarded = collectCodexArtifacts(input)
    .then(indexCodexArtifacts)
    .catch((error: unknown) => {
      codexArtifactsCache.delete(input)
      throw error
    })
  codexArtifactsCache.set(input, guarded)
  return guarded
}

function rootOf(selected: ParsedSession, byId: ReadonlyMap<string, ParsedSession>): ParsedSession {
  let current = selected
  const visited = new Set<string>()
  while (current.parentNativeSessionId && !visited.has(current.originalSessionId)) {
    visited.add(current.originalSessionId)
    const parent = byId.get(current.parentNativeSessionId)
    if (!parent) break
    current = parent
  }
  return current
}

function conversationTree(
  parsed: ParsedSession,
  children: ReadonlyMap<string, ParsedSession[]>,
  visited = new Set<string>()
): ImportedConversation {
  const conversation = toConversation(parsed)
  if (visited.has(parsed.originalSessionId)) return conversation
  visited.add(parsed.originalSessionId)
  const nested = (children.get(parsed.originalSessionId) ?? []).map((child) =>
    conversationTree(child, children, visited)
  )
  if (nested.length > 0) conversation.nested = nested
  return conversation
}

function enrichCodexGraph(
  graph: ReturnType<typeof buildImportedSessionGraph>,
  parsedById: ReadonlyMap<string, ParsedSession>
): void {
  for (const node of graph.nodes) {
    const nativeId = node.session.header.runtimeBinding?.nativeSessionId
    const parsed = nativeId ? parsedById.get(nativeId) : undefined
    if (!parsed) continue
    if (parsed.goals.length > 0) node.session.goals = parsed.goals
    if (parsed.plans.length > 0) node.session.plans = parsed.plans
    if (parsed.tasks.length > 0) node.session.tasks = parsed.tasks
    if (parsed.history.length > 0) node.session.history = parsed.history
    if (parsed.interAgentMessages.length > 0) {
      node.session.interAgentMessages = parsed.interAgentMessages
    }
    if (parsed.recordedEvents.length > 0) node.session.recordedEvents = parsed.recordedEvents
    node.loss.losses.push(...parsed.losses)
  }
}

export const codexSessionSource: AgentSessionSourceAdapter = {
  codec: codexCodec,
  id: CODEX_HISTORY_FORMAT.sourceId,
  displayName: "Codex CLI",
  labelKey: "codex",
  verifiedVersion: CODEX_HISTORY_FORMAT.verifiedVersion,
  verifiedAt: CODEX_HISTORY_FORMAT.verifiedAt,
  acceptedExtensions: [...CODEX_HISTORY_FORMAT.acceptedExtensions],

  // `$CODEX_HOME` relocates the whole tree; `roots` carries it (the renderer
  // can't read env vars — see `lib/agent-roots/`).
  scanRoots(home, roots) {
    const base = roots?.codexHome || (home ? joinPath(home, ".codex") : "")
    return base ? [joinPath(base, "sessions")] : []
  },

  detect(files: PickedSessionFile[]) {
    return detectCodexRollouts(files)
  },

  summarizeFile: summarizeCodexFile,

  async listSessions(input: SessionScanInput) {
    // The children filter used to `Promise.all` a full `parseCodexRollout`
    // over every file — a second complete corpus read+parse, all of it in
    // flight at once — just to learn each file's parent id. `summarizeCodexFile`
    // now carries `parentNativeSessionId`, so the filter is pure memory.
    const summaries = await scanCodexSummaries(input)
    const nativeIds = new Set(summaries.map((summary) => summary.ref.originalSessionId))
    return summaries.filter(
      (summary) => !summary.parentNativeSessionId || !nativeIds.has(summary.parentNativeSessionId)
    )
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    const content = await readRolloutContent(ref, input)
    return toConversation(parseCodexRollout(content, ref.locator))
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput, opts?: { singleFile?: boolean }) {
    // `singleFile` (fs-watch path): graph just the changed rollout. Children
    // are skipped — their own file events import them — so one append does
    // not cost a full corpus scan+parse.
    const singleArtifact = opts?.singleFile
      ? parseCodexRollout(await readRolloutContent(ref, input), ref.locator)
      : undefined
    // Keep ID/child indexes for the same lifetime as the already-cached parse.
    // Rebuilding them for every selected ref made large batch imports quadratic.
    const index = singleArtifact
      ? indexCodexArtifacts([singleArtifact])
      : await parseCodexArtifacts(input)
    const { byId: parsedById, children } = index
    // The selected session is almost always already in the cached artifact
    // pass — re-reading + re-parsing its file (up to hundreds of MB) per ref
    // was the second half of the freeze. Only a ref the scan didn't produce
    // (e.g. a watch event on a file created mid-run) falls back to a direct
    // read.
    let selected = ref.originalSessionId ? parsedById.get(ref.originalSessionId) : undefined
    if (!selected) {
      // singleFile: singleArtifact is this ref's own parse — reuse it. Corpus
      // mode: the ref wasn't in the scan (stale summary, or a picked file
      // outside the roots) — read it directly rather than substitute another
      // corpus member.
      selected =
        singleArtifact ?? parseCodexRollout(await readRolloutContent(ref, input), ref.locator)
      if (!parsedById.has(selected.originalSessionId)) {
        addCodexArtifact(index, selected)
      }
    }
    const root = rootOf(selected, parsedById)
    const graph = buildImportedSessionGraph(conversationTree(root, children), {
      sourceRuntime: this.id,
      sourceVersion: root.sourceVersion || selected.sourceVersion || this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    enrichCodexGraph(graph, parsedById)
    return graph
  },
}
