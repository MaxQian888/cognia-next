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
   * Absolute roots this source scans on a desktop auto-scan, given the resolved
   * home dir. Empty array = this source has no filesystem scan (picker only).
   */
  scanRoots(home: string): string[]
  /**
   * Heuristic used by `detectSourceForFiles` to pick the source for a batch of
   * hand-picked files. Path hints (e.g. ".codex/sessions") are the usual tell.
   */
  detect(files: PickedSessionFile[]): SessionDetectVerdict
  /** List the sessions available from a scan (or from `input.pickedFiles`). */
  listSessions(input: SessionScanInput): Promise<SessionSummary[]>
  /** Parse ONE listed session into the canonical conversation shape. */
  parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation>
}

export type { ImportedConversation } from "@/lib/data/importers/types"
