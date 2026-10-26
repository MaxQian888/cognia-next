// Contracts for the external-agent session-history import subsystem.
//
// This is the extension point: a source adapter knows how to (a) locate the
// sessions a given coding agent persists on disk, and (b) parse one of them
// into the app's canonical `ImportedConversation` shape (reused verbatim from
// the chat-export importer so `applyImported` persists it unchanged).
//
// The two-step `listSessions` / `parseSession` split mirrors the reality of
// on-disk histories: a scan is cheap (titles, counts) while a full parse is
// only paid for the sessions the user actually imports.
//
// Deliberately modeled on the clean `SubagentSourceAdapter` registry
// (`lib/claude/subagent-importers/`) rather than the in-memory `ChatImporter`
// (single-JSON-blob, closed format union) — see ADR-0062.

import type {
  CanonicalSession,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"
import type { SessionRef } from "@cognia/plugin-contract/lib/session-import/types"
export type {
  AgentSessionSourceAdapter,
  ImportedSessionGraph,
  ImportedSessionGraphNode,
  PickedSessionFile,
  SessionDetectVerdict,
  SessionFs,
  SessionRef,
  SessionScanInput,
  SessionSummary,
  UsageScanBatch,
  UsageScanQuery,
} from "@cognia/plugin-contract/lib/session-import/types"

/** A selected session that could not be parsed; retained for an actionable result. */
export interface SessionImportFailure {
  ref: SessionRef
  code: "source-unavailable" | "parse-failed"
  message?: string
}

/** Per-session provenance shown after import and retained independently of the aggregate. */
export interface SessionImportDetail {
  sourceId: string
  canonicalSessionId: string
  title?: string
  sourceVersion?: string
  sourceRevision?: string
  runtimeBinding?: CanonicalSession["header"]["runtimeBinding"]
  lineage?: CanonicalSession["header"]["lineage"]
  lifecycle?: CanonicalSession["header"]["lifecycle"]
  loss: SessionLossReport
}

/* ── Usage scanning (ADR-0165 Phase 0) ────────────────────────────────── */

/** Phase of an in-flight import, for progress reporting. */
export type ImportPhase = "parsing" | "writing"

/** Progress tick emitted while importing a batch of sessions. */
export interface ImportProgress {
  phase: ImportPhase
  /** Sessions parsed (parsing phase) or persisted (writing phase) so far. */
  done: number
  /** Total sessions selected for this import. */
  total: number
}

/** Optional controls for a (potentially large) import run. */
export interface ImportOptions {
  /** Abort the run between sessions / write chunks. Partial progress is kept. */
  signal?: AbortSignal
  /** Called on each parse step and after each persisted chunk. */
  onProgress?: (progress: ImportProgress) => void
  /** Called only when a ref was parsed without throwing, including empty transcripts. */
  onRefParsed?: (ref: SessionRef) => void
  /**
   * Parsed conversations are flushed to Dexie every `chunkSize` sessions
   * instead of buffering the whole selection into one giant transaction.
   */
  chunkSize?: number
  /**
   * Each ref is parsed from its own file only — set by the fs-watch live-sync
   * path, where one changed transcript must not re-scan the source's whole
   * corpus. Forwarded to `parseGraph`; see {@link AgentSessionSourceAdapter.parseGraph}.
   */
  singleFile?: boolean
}

export type { ImportedConversation } from "@/lib/data/importers/types"
