/**
 * The neutral transcript an integration's history reader returns (ADR-0217).
 *
 * A reader turns one agent's on-disk session format into these records and
 * nothing else: it never builds the host's chat rows, never touches a
 * database, and never reads the filesystem itself. The host owns discovery
 * (which files, under which roots, with which budget), the single mapping into
 * its own message and session shapes, and storage. Keeping the reader to a
 * pure `content → ParsedHistorySession` function is what lets the same package
 * serve the desktop app, the CLI and a headless host.
 */

import type {
  CanonicalHistoryEvent,
  CanonicalInterAgentMessage,
  CanonicalRecordedEvent,
  CanonicalSessionGoal,
  CanonicalSessionLifecycle,
  CanonicalSessionLifecycleStatus,
  CanonicalSessionPlan,
  CanonicalSessionRelationKind,
  CanonicalSessionTask,
  SessionLossEntry,
} from "./canonical-session"

/** The recorded result of a tool call. */
export type HistoryToolResult = { ok: true; output: unknown } | { ok: false; errorText: string }

/** A tool call as the transcript recorded it, resolved or not. */
export interface HistoryToolPart {
  type: "tool"
  /** The runtime's own tool name, unmapped. */
  name: string
  toolCallId: string
  input: unknown
  /** Absent while the transcript holds no result for the call. */
  result?: HistoryToolResult
  /** A status string the runtime recorded verbatim (`completed`, `failed`, …). */
  status?: string
}

export type HistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "file"
      mediaType: string
      /** A `data:` URL or an absolute URL, exactly as recorded. */
      url: string
      filename?: string
    }
  | {
      /** Assistant progress narration a runtime separates from its answer. */
      type: "commentary"
      text: string
      messageId?: string
      /** Which runtime produced it, for the renderer's attribution. */
      source: string
    }
  | HistoryToolPart

/** Token usage of one turn, as the transcript recorded it. */
export interface HistoryUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  /** The runtime's own cost estimate for the turn, in US dollars, when it records one. */
  totalCostUsd?: number
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system"
  parts: HistoryPart[]
  /** Epoch ms. */
  createdAt: number
  /** Usage of the turn this message closed. */
  usage?: HistoryUsage
  /** The model the transcript attributed {@link usage} to. */
  usageModel?: string
  /** Runtime-specific annotations the host keeps verbatim (namespaced keys). */
  annotations?: Record<string, unknown>
}

/** One parsed session: transcript plus the structured state the format records. */
export interface ParsedHistorySession {
  /** The session-source id this reader serves (`codex`, `pi`, …). */
  sourceId: string
  /** The runtime's own session id; the locator when the file records none. */
  originalSessionId: string
  cwd?: string
  model?: string
  title: string
  messages: HistoryMessage[]
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms. */
  updatedAt: number
  /** Upstream format/runtime version the file was written by, when recorded. */
  sourceVersion?: string
  relationKind?: CanonicalSessionRelationKind
  parentNativeSessionId?: string
  lifecycle?: CanonicalSessionLifecycle
  goals: CanonicalSessionGoal[]
  plans: CanonicalSessionPlan[]
  tasks: CanonicalSessionTask[]
  history: CanonicalHistoryEvent[]
  interAgentMessages: CanonicalInterAgentMessage[]
  recordedEvents: CanonicalRecordedEvent[]
  /** Everything the reader dropped or approximated. Never silently empty. */
  losses: SessionLossEntry[]
}

/** A cheap per-file summary for a session picker, built without a full parse. */
export interface HistorySessionSummary {
  sourceId: string
  originalSessionId: string
  title: string
  /** Approximate number of visible turns. */
  messageCount: number
  /** Epoch ms of the last activity. */
  updatedAt: number
  cwd?: string
  sourceVersion?: string
  relationKind?: CanonicalSessionRelationKind
  lifecycleStatus?: CanonicalSessionLifecycleStatus
  parentNativeSessionId?: string
}

/** A file the user picked, offered to a reader for format detection. */
export interface HistoryPickedFile {
  path: string
  name: string
  content: string
}

export type HistoryDetectVerdict = "match" | "maybe" | "no"

/**
 * Host services a reader needs. Readers keep bounded diagnostics of records
 * they cannot map; `redactText` is the host's PII redactor, applied to every
 * string such a diagnostic retains. It is required so no reader can keep raw
 * transcript text in a diagnostic.
 */
export interface HistoryReaderHost {
  redactText(text: string): string
}

/** Facts about the format version a reader was verified against. */
export interface HistoryFormatInfo {
  sourceId: string
  /** Upstream version the reader was last verified against. */
  verifiedVersion: string
  /** ISO date of that verification. */
  verifiedAt: string
  /** File extensions the format uses, lower case with the dot. */
  acceptedExtensions: readonly string[]
}
