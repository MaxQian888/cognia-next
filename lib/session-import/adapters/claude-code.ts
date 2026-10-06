// Claude Code CLI session-history source.
//
// The transcript format itself is read by `@cognia/agent-claude-code/history`
// (ADR-0217): this module owns only what the host decides — where transcripts
// live (`<claudeConfigDir>/projects`, with `$CLAUDE_CONFIG_DIR` resolved in Rust
// and delivered through `SessionScanInput.roots`), how the transcript, its
// independent subagent files and the team/task artifacts are read and
// budgeted, and how a parsed transcript becomes app rows: subagent cards
// (`SubagentPart`) on the spawning turn, hidden nested subagent sessions, team
// members, and the imported session graph.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import type {
  CanonicalRecordedEvent,
  CanonicalSessionTask,
  SessionLossEntry,
} from "@cognia/agent-config-types/canonical-session"
import type { HistoryReaderHost } from "@cognia/agent-contracts/history"
import type { SidechainGroup } from "@cognia/agent-runtime-kit/history-dag"
import {
  CLAUDE_CODE_HISTORY_FORMAT,
  claudeCodeTaskStatus,
  claudeCodeTeamSnapshot,
  detectClaudeCodeTranscripts,
  readClaudeCodeTranscript,
  summarizeClaudeCodeTranscript,
  type ClaudeCodeTeamArtifact,
  type ClaudeCodeTeamCorpus,
  type ClaudeCodeTeamSnapshot,
  type ClaudeLine,
} from "@cognia/agent-claude-code/history"
import { CLAUDE_CODE_PRESET_ID } from "@cognia/agent-claude-code/manifest"
import { redactText } from "@cognia/redact"
import { walkFiles } from "../fs"
import { everyBudget, mapBounded } from "../pacing"
import { scanFileSummaries } from "../scan"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored, historySummaryToSessionSummary } from "../history-to-stored"
import { buildSubagentSnapshot } from "./claude-code-subagent"
import { buildSession, importedMessageId, importedSessionId } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

export type { ClaudeLine }

/** Diagnostics the reader keeps are passed through the app's PII redactor. */
const readerHost: HistoryReaderHost = { redactText: (text) => redactText(text).redacted }

interface ParsedSession {
  originalSessionId: string
  cwd?: string
  model?: string
  title: string
  messages: StoredMessage[]
  /**
   * Subagent (Task/sidechain) runs extracted from this transcript, each
   * linearized to its own active leaf (raw form; kept for transparency/tests).
   */
  sidechains: SidechainGroup<ClaudeLine>[]
  /**
   * Hidden `kind: "subagent"` inner-transcript sessions reconstructed from the
   * sidechains. Persisted as top-level rows alongside the main conversation.
   */
  nestedConversations: ImportedConversation[]
  createdAt: number
  updatedAt: number
  agentId?: string
  /** The tasks the transcript's `Task*` tool calls record. */
  tasks: CanonicalSessionTask[]
  recordedEvents: CanonicalRecordedEvent[]
  losses: SessionLossEntry[]
}

/** Parse the raw JSONL body of one Claude Code transcript file into app rows. */
export function parseClaudeTranscript(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const read = readClaudeCodeTranscript(content, locatorId, readerHost)
  const main = read.session
  const finalId = importedSessionId(main.sourceId, main.originalSessionId)
  const messages = historyMessagesToStored(finalId, main.messages, projectId)

  // Each subagent run becomes a `SubagentPart` snapshot attached to its
  // spawning turn PLUS a hidden nested session holding the full inner
  // transcript to drill into.
  const nestedConversations: ImportedConversation[] = []
  for (const run of read.subagents) {
    const nestedId = `${finalId}:sub:${run.subagentId}`
    const nestedMessages = historyMessagesToStored(nestedId, run.messages, projectId)
    const hostMsg = run.hostMessageIndex !== undefined ? messages[run.hostMessageIndex] : undefined
    const part = buildSubagentSnapshot({
      subagentId: run.subagentId,
      parentSessionId: finalId,
      name: run.name,
      nestedSessionId: nestedId,
      messages: nestedMessages,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })
    if (hostMsg) (hostMsg.parts as unknown[]).push(part)

    const nestedSession = buildSession({
      id: nestedId,
      projectId,
      title: run.title,
      kind: "subagent",
      suppressSeed: true,
      workingDir: main.cwd,
      createdAt: run.startedAt,
      updatedAt: run.completedAt,
      seedMessages: [],
    })
    nestedSession.parentSessionId = finalId
    nestedSession.importRelation = {
      kind: "subagent",
      parentToolCallId: run.spawnParentUuid ?? undefined,
    }
    nestedSession.importRuntimeBinding = {
      presetId: CLAUDE_CODE_PRESET_ID,
      nativeSessionId: run.subagentId,
      cwd: main.cwd,
    }
    nestedConversations.push({ session: nestedSession, messages: nestedMessages })
  }

  return {
    originalSessionId: main.originalSessionId,
    cwd: main.cwd,
    model: main.model,
    title: main.title,
    messages,
    sidechains: read.sidechains,
    nestedConversations,
    createdAt: main.createdAt,
    updatedAt: main.updatedAt,
    agentId: read.agentId,
    tasks: main.tasks,
    recordedEvents: main.recordedEvents,
    losses: main.losses,
  }
}

/** Cheap single-pass summary for the scan list (no DAG, no messages). */
export function summarizeClaudeFile(content: string, locator: string): SessionSummary | null {
  const summary = summarizeClaudeCodeTranscript(content, locator)
  return summary ? historySummaryToSessionSummary(summary, locator) : null
}

function toConversation(parsed: ParsedSession, projectId?: string): ImportedConversation {
  const id = importedSessionId("claude-code", parsed.originalSessionId)
  const session = buildSession({
    id,
    projectId,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
  })
  session.importRuntimeBinding = {
    presetId: CLAUDE_CODE_PRESET_ID,
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
  }
  return {
    session,
    messages: parsed.messages,
    ...(parsed.nestedConversations.length > 0 ? { nested: parsed.nestedConversations } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

async function readJsonFiles(
  input: SessionScanInput,
  root: string,
  accept: (path: string) => boolean
): Promise<ClaudeCodeTeamArtifact[]> {
  const values: ClaudeCodeTeamArtifact[] = []
  const picked = input.pickedFiles?.filter((file) => accept(file.path))
  if (picked) {
    for (const file of picked) {
      try {
        const value = record(JSON.parse(file.content))
        if (value) values.push({ path: file.path, value })
      } catch {
        // The graph fidelity report covers malformed optional artifacts through
        // the missing structured state; the parent transcript remains usable.
      }
    }
    return values
  }
  if (!(await input.fs.exists(root))) return values
  const files = await walkFiles(input.fs, root, accept)
  const budget = everyBudget()
  const loaded = await mapBounded(files, 8, async (path) => {
    await budget()
    try {
      const value = record(JSON.parse(await input.fs.readTextFile(path)))
      return value ? { path, value } : null
    } catch {
      // One team/task artifact must not sink the transcript import.
      return null
    }
  })
  for (const item of loaded) {
    if (item) values.push(item)
  }
  return values
}

async function collectClaudeCodeTeamCorpus(input: SessionScanInput): Promise<ClaudeCodeTeamCorpus> {
  const base = input.roots?.claudeConfigDir || (input.home ? joinPath(input.home, ".claude") : "")
  if (!base && !input.pickedFiles?.length) {
    return { configs: [], taskFiles: [] }
  }
  const configs = await readJsonFiles(
    input,
    joinPath(base, "teams"),
    (path) => path.replace(/\\/g, "/").includes("/teams/") && path.endsWith("config.json")
  )
  // Read the whole tasks tree once; the per-team narrowing happens at
  // snapshot time on the full paths, so it can be reused across refs.
  const taskFiles = await readJsonFiles(input, joinPath(base, "tasks"), (path) =>
    path.toLowerCase().endsWith(".json")
  )
  return { configs, taskFiles }
}

/**
 * Team/task artifact reads, cached on the `SessionScanInput`. `parseGraph`
 * needs a snapshot per ref, and every ref used to re-walk and re-read all of
 * `~/.claude/teams` and `~/.claude/tasks` — K refs meant K passes. Weakly
 * keyed like `collectSessions` in `opencode.ts`: fresh scan → fresh input →
 * no staleness.
 */
const claudeTeamCorpusCache = new WeakMap<SessionScanInput, Promise<ClaudeCodeTeamCorpus>>()

function claudeTeamCorpus(input: SessionScanInput): Promise<ClaudeCodeTeamCorpus> {
  const cached = claudeTeamCorpusCache.get(input)
  if (cached) return cached
  // Evict a FAILED read so the next attempt actually retries — a rejected
  // promise left in the cache would poison every later ref on this input.
  const guarded = collectClaudeCodeTeamCorpus(input).catch((error: unknown) => {
    claudeTeamCorpusCache.delete(input)
    throw error
  })
  claudeTeamCorpusCache.set(input, guarded)
  return guarded
}

async function loadClaudeTeamSnapshot(
  input: SessionScanInput,
  nativeSessionId: string,
  cwd?: string
): Promise<ClaudeCodeTeamSnapshot> {
  return claudeCodeTeamSnapshot(await claudeTeamCorpus(input), nativeSessionId, cwd)
}

function addTeamMembers(
  root: ImportedConversation,
  snapshot: ClaudeCodeTeamSnapshot,
  parsed: ParsedSession
): void {
  const nested = root.nested ?? []
  const existingNativeIds = new Set(
    nested.map((child) => child.session.importRuntimeBinding?.nativeSessionId).filter(Boolean)
  )
  // Resolve ownership once, retaining task order when a member matches both
  // its display name and agent ID. Undefined owners deliberately remain keys:
  // older artifacts may omit either member field, and the old scan matched it.
  let firstTaskByOwner:
    Map<string | undefined, { task: CanonicalSessionTask; index: number }> | undefined
  for (const member of snapshot.members) {
    const nativeId =
      stringValue(member.sessionId) || stringValue(member.agentId) || stringValue(member.name)
    if (!nativeId || nativeId === parsed.originalSessionId || existingNativeIds.has(nativeId))
      continue
    const memberName = stringValue(member.name)
    const memberAgentId = stringValue(member.agentId)
    if (!firstTaskByOwner) {
      firstTaskByOwner = new Map()
      for (const [index, task] of snapshot.tasks.entries()) {
        const owner = snapshot.taskOwnerById.get(task.taskId)
        if (!firstTaskByOwner.has(owner)) firstTaskByOwner.set(owner, { task, index })
      }
    }
    const byName = firstTaskByOwner.get(memberName)
    const byAgentId = firstTaskByOwner.get(memberAgentId)
    const ownedTask =
      !byName || (byAgentId && byAgentId.index < byName.index) ? byAgentId?.task : byName.task
    const id = importedSessionId("claude-code", nativeId)
    const session = buildSession({
      id,
      title: memberName || nativeId,
      kind: "subagent",
      suppressSeed: true,
      workingDir: stringValue(member.cwd) || parsed.cwd,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      seedMessages: [],
    })
    session.parentSessionId = root.session.id
    session.importRelation = {
      kind: "team-member",
      parentNativeSessionId: parsed.originalSessionId,
      ...(ownedTask ? { taskId: ownedTask.taskId } : {}),
    }
    session.importLifecycle = {
      status: ownedTask?.status ?? claudeCodeTaskStatus(member.status),
      background: true,
    }
    session.importRuntimeBinding = {
      presetId: CLAUDE_CODE_PRESET_ID,
      nativeSessionId: nativeId,
      cwd: stringValue(member.cwd) || parsed.cwd,
    }
    nested.push({ session, messages: [] })
  }
  if (nested.length > 0) root.nested = nested
}

import { claudeCodeCodec } from "@/lib/session-import/codecs/claude-code-codec"

/**
 * `parseSession` and `parseGraph` share one transcript read+parse. The graph
 * path needs the `ParsedSession` (native id, cwd, recorded events, losses) in
 * addition to the conversation — it used to read and parse the file a second
 * time to get them, doubling per-ref cost on multi-MB transcripts.
 */
async function parseClaudeConversation(
  ref: SessionRef,
  input: SessionScanInput
): Promise<{ conversation: ImportedConversation; parsed: ParsedSession }> {
  let content: string
  if (input.pickedFiles?.length) {
    const picked = input.pickedFiles.find((f) => f.path === ref.locator)
    content = picked?.content ?? ""
  } else {
    content = await input.fs.readTextFile(ref.locator)
  }
  const parsed = parseClaudeTranscript(content, ref.locator)
  const conversation = toConversation(parsed)
  const childArtifacts: Array<{ content: string; locator: string }> = []
  const addChildArtifacts = (): ImportedConversation[] => {
    const grouped = new Map<string, ParsedSession[]>()
    for (const artifact of childArtifacts) {
      const child = parseClaudeTranscript(artifact.content, artifact.locator)
      const existing = grouped.get(child.originalSessionId)
      if (existing) existing.push(child)
      else grouped.set(child.originalSessionId, [child])
    }
    return [...grouped.values()].flatMap((segments) => {
      const ordered = segments.toSorted((a, b) => a.createdAt - b.createdAt)
      const first = ordered[0]
      if (!first) return []
      const nestedId = importedSessionId("claude-code", first.originalSessionId)
      const messages = ordered
        .flatMap((segment) => segment.messages)
        .map((message, index) => ({
          ...message,
          id: importedMessageId(nestedId, index),
          sessionId: nestedId,
        }))
      if (messages.length === 0) return []
      const nested = toConversation({
        ...first,
        messages,
        nestedConversations: ordered.flatMap((segment) => segment.nestedConversations),
        updatedAt: Math.max(...ordered.map((segment) => segment.updatedAt)),
      })
      nested.session.kind = "subagent"
      nested.session.branchSeed = undefined
      nested.session.parentSessionId = conversation.session.id
      nested.session.importRelation = {
        kind: "subagent",
        parentNativeSessionId: parsed.originalSessionId,
      }
      nested.session.importRuntimeBinding = {
        presetId: CLAUDE_CODE_PRESET_ID,
        nativeSessionId: first.originalSessionId,
        cwd: first.cwd,
      }
      return [nested]
    })
  }

  if (input.pickedFiles?.length) {
    const childPrefix = `${ref.locator.replace(/\.jsonl$/i, "")}/subagents/`.replace(/\\/g, "/")
    for (const file of input.pickedFiles) {
      if (file.path.replace(/\\/g, "/").startsWith(childPrefix)) {
        childArtifacts.push({ content: file.content, locator: file.path })
      }
    }
  } else {
    const childDir = joinPath(ref.locator.replace(/\.jsonl$/i, ""), "subagents")
    if (await input.fs.exists(childDir)) {
      const files = await walkFiles(input.fs, childDir, (name) =>
        name.toLowerCase().endsWith(".jsonl")
      )
      const children = await mapBounded(files, 8, async (file) => {
        try {
          return { content: await input.fs.readTextFile(file), locator: file }
        } catch {
          // Preserve the parent and other children if one transcript is corrupt.
          return null
        }
      })
      for (const child of children) {
        if (child) childArtifacts.push(child)
      }
    }
  }

  const independent = addChildArtifacts()
  if (independent.length > 0) {
    conversation.nested = [...(conversation.nested ?? []), ...independent]
  }
  return { conversation, parsed }
}

export const claudeCodeSessionSource: AgentSessionSourceAdapter = {
  codec: claudeCodeCodec,
  id: "claude-code",
  displayName: "Claude Code",
  labelKey: "claude-code",
  verifiedVersion: CLAUDE_CODE_HISTORY_FORMAT.verifiedVersion,
  verifiedAt: CLAUDE_CODE_HISTORY_FORMAT.verifiedAt,
  acceptedExtensions: [...CLAUDE_CODE_HISTORY_FORMAT.acceptedExtensions],

  // `$CLAUDE_CONFIG_DIR` relocates the whole tree; `roots` carries it (the
  // renderer can't read env vars — see `lib/agent-roots/`).
  scanRoots(home, roots) {
    const base = roots?.claudeConfigDir || (home ? joinPath(home, ".claude") : "")
    return base ? [joinPath(base, "projects")] : []
  },

  detect(files: PickedSessionFile[]) {
    return detectClaudeCodeTranscripts(files)
  },

  summarizeFile: summarizeClaudeFile,

  async listSessions(input: SessionScanInput) {
    const summaries = await scanFileSummaries(
      input,
      this.scanRoots(input.home, input.roots),
      (n) => n.toLowerCase().endsWith(".jsonl"),
      summarizeClaudeFile
    )
    return summaries.filter((summary) => summary.relationKind !== "subagent")
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    return (await parseClaudeConversation(ref, input)).conversation
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput, opts?: { singleFile?: boolean }) {
    // One transcript read+parse serves both the conversation and the
    // canonical enrichment below — no second pass over the file.
    const { conversation, parsed } = await parseClaudeConversation(ref, input)
    // `singleFile` (fs-watch path): skip the teams/tasks dirs — a transcript
    // append must not re-walk them, and team members persist from the import
    // that created them.
    const snapshot = opts?.singleFile
      ? { members: [], tasks: [], taskOwnerById: new Map<string, string>() }
      : await loadClaudeTeamSnapshot(input, parsed.originalSessionId, parsed.cwd)
    addTeamMembers(conversation, snapshot, parsed)
    const transcriptTasks = parsed.tasks
    const tasks = new Map(
      [...transcriptTasks, ...snapshot.tasks].map((task) => [task.taskId, task])
    )
    conversation.session.importCanonicalState = {
      ...(conversation.session.importCanonicalState ?? {}),
      ...(tasks.size > 0 ? { tasks: [...tasks.values()] } : {}),
    }
    for (const child of conversation.nested ?? []) {
      const nativeId = child.session.importRuntimeBinding?.nativeSessionId
      const task = nativeId ? tasks.get(nativeId) : undefined
      if (task?.background) {
        child.session.importRelation = {
          ...(child.session.importRelation ?? { kind: "background" }),
          kind: "background",
          taskId: task.taskId,
        }
        child.session.importLifecycle = { status: task.status, background: true }
      }
    }
    const graph = buildImportedSessionGraph(conversation, {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    const root = graph.nodes[0]
    if (root) {
      if (parsed.recordedEvents.length > 0) root.session.recordedEvents = parsed.recordedEvents
      root.loss.losses.push(...parsed.losses)
    }
    return graph
  },
}
