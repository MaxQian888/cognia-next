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

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { VendorRoots } from "@/lib/agent-roots"

/** A single file the user picked (or that a scan materialized). */
export interface PickedSessionFile {
  /** Basename, e.g. "rollout-2025-01-03-uuid.jsonl". */
  name: string
  /** Absolute path on desktop; may be a synthetic id in web/picker mode. */
  path: string
  /** UTF-8 contents. */
  content: string
}

/**
 * Minimal filesystem surface the adapters need. Superset of
 * {@link import("@/lib/memory/external/types").ExternalFs} — adds the content
 * reads the memory discovery layer never needed. The real implementation wraps
 * `lib/file/file-operations.ts`; tests inject a fake.
 */
export interface SessionFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; isFile: boolean }>
  readTextFile(path: string): Promise<string>
}

/** Everything an adapter needs to scan / parse. */
export interface SessionScanInput {
  fs: SessionFs
  /** OS home dir, no trailing separator (from `resolveHome`). Empty in web mode. */
  home: string
  /**
   * Resolved per-vendor config/data roots, honouring `$CLAUDE_CONFIG_DIR`,
   * `$CODEX_HOME` and `$XDG_*` (see `lib/agent-roots/`). Adapters must prefer
   * these over deriving `<home>/.codex` themselves. Optional so existing
   * callers (and tests) that only have a home dir keep working — adapters fall
   * back to the home-relative default when it's absent.
   */
  roots?: VendorRoots
  /**
   * Files the user hand-picked (web / picker fallback). When present, adapters
   * should parse these instead of walking the filesystem. Undefined on a
   * desktop auto-scan.
   */
  pickedFiles?: PickedSessionFile[]
}

/** Opaque handle identifying one listed session, understood by its own adapter. */
export interface SessionRef {
  /** Adapter id that produced this ref. */
  sourceId: string
  /** The upstream session id (stable — drives dedupe on re-import). */
  originalSessionId: string
  /** Where the session lives on disk (file path, dir, or db row key). */
  locator: string
}

/** A listed-but-not-yet-imported session shown in the picker. */
export interface SessionSummary {
  ref: SessionRef
  /** Display title (first user turn, truncated). */
  title: string
  /** Owning source, for grouping / badges. */
  sourceId: string
  /** Number of visible turns (approximate — for the row subtitle). */
  messageCount: number
  /** Epoch ms of the last activity (sort key). */
  updatedAt: number
  /** Optional source-derived content revision for timestamp-preserving updates. */
  watchRevision?: string
  /** Working directory the session ran in, when the source records it. */
  cwd?: string
}

/** Likelihood a batch of picked files came from this source (auto-detect). */
export type SessionDetectVerdict = "match" | "maybe" | "no"

/**
 * A source of importable agent session histories. First-party sources
 * (claude-code / codex / opencode) are static; plugins contribute more through
 * `registerSessionSource` (see `registry.ts`).
 */
export interface AgentSessionSourceAdapter {
  /** Stable id: "claude-code" | "codex" | "opencode" | "<pluginId>:<x>". */
  id: string
  /** Human label for the source tab. */
  displayName: string
  /** i18n suffix under `settings.sessionImport.sources.<labelKey>`. */
  labelKey: string
  /** File extensions the picker accepts for this source (".jsonl", ".db"). */
  acceptedExtensions: string[]
  /**
   * Absolute roots this source scans on a desktop auto-scan. `roots` carries
   * the environment-aware per-vendor directories (`lib/agent-roots/`); when it
   * is absent the adapter falls back to the conventional home-relative path.
   * Empty array = this source has no filesystem scan (picker only).
   */
  scanRoots(home: string, roots?: VendorRoots): string[]
  /**
   * Heuristic used by `detectSourceForFiles` to pick the source for a batch of
   * hand-picked files. Path hints (e.g. ".codex/sessions") are the usual tell.
   */
  detect(files: PickedSessionFile[]): SessionDetectVerdict
  /** List the sessions available from a scan (or from `input.pickedFiles`). */
  listSessions(input: SessionScanInput): Promise<SessionSummary[]>
  /** Parse ONE listed session into the canonical conversation shape. */
  parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation>
  /**
   * OPTIONAL cheap summary of one file's raw content — a single pass that pulls
   * only title / count / timestamps / cwd WITHOUT building any `StoredMessage`,
   * resolving the DAG, or reconstructing subagents (all of which `parseSession`
   * does and the scan throws away). When a per-file source implements this, the
   * desktop scan uses it instead of a full parse, so listing a large history
   * costs O(bytes) parse instead of O(bytes) parse + O(messages) allocation.
   *
   * Returns `null` for a file that yields no importable session (empty/corrupt).
   * Sources whose history isn't a set of standalone files (e.g. OpenCode's
   * single SQLite DB) leave this undefined and keep their own `listSessions`.
   */
  summarizeFile?(content: string, locator: string): SessionSummary | null
  /**
   * OPTIONAL bidirectional codec (ADR-0090 Phase 8): converts this source's
   * parsed conversations into the runtime-neutral `CanonicalSession` (with an
   * honest loss report), and MAY declare a `materialize` capability for the
   * reverse direction. Absent = honest import-only source.
   */
  codec?: import("./codec-types").SessionCodec
}

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
}

export type { ImportedConversation } from "@/lib/data/importers/types"
