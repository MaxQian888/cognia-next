// Shared types for the external subagent importer pipeline.
//
// The pipeline has four stages:
//   1. Source adapters (claude-code / codex-cli / cursor / cline / generic-md)
//      take raw `.md` text + filename and produce normalized `SubagentImportDraft`.
//   2. `convert.ts` maps a draft to either a `SubAgentTemplate` or a Character draft.
//   3. `apply.ts` applies the conversion to the runtime store / Dexie with a
//      merge strategy (skip / overwrite / duplicate).
//   4. `subagent-import-dialog.tsx` is the UI that drives all three.

export type SubagentSourceId = "claude-code" | "codex-cli" | "cursor" | "cline" | "generic-md"

/** A single file's worth of input text, with enough metadata to detect the source. */
export interface ImportFile {
  /** Filename without directory, e.g. "code-reviewer.md". */
  filename: string
  /** Source-relative path with directory hints, e.g. ".claude/agents/code-reviewer.md".
   *  May be "<pasted>" when the user pastes raw text. */
  sourcePath: string
  /** UTF-8 contents. */
  content: string
}

export interface ImportInput {
  files: ImportFile[]
  /** Optional absolute root directory (Tauri-only) — adapters use it to
   *  improve `detect()` heuristics. Web mode leaves this undefined. */
  rootDir?: string
}

/** A single failed parse. Non-fatal — the dialog surfaces these as warnings. */
export interface ParseFailure {
  filename: string
  error: string
}

/** Normalized subagent shape produced by every adapter. */
export interface SubagentImportDraft {
  /** Adapter that produced this draft. */
  source: SubagentSourceId
  /** Stable cross-import id, "<source>:<slug>". Used for dedupe in the UI. */
  sourceKey: string
  name: string
  description?: string
  /** Markdown body. Becomes `Character.systemPrompt` or
   *  `SubAgentTemplate.config.systemPrompt`. */
  systemPrompt: string
  tools?: string[]
  model?: string
  /** Best-guess provider for the upstream tool. */
  providerHint?: "anthropic" | "openai" | "gemini"
  /** Raw frontmatter, retained for debugging / future round-trip. */
  rawFrontmatter?: Record<string, unknown>
  /** Where the draft came from on disk (or "<pasted>"). */
  sourceFile: string
  /** Non-fatal warnings: name fallback, unknown model, missing tools, etc. */
  warnings: string[]
}

export interface ParseResult {
  drafts: SubagentImportDraft[]
  errors: ParseFailure[]
}

/** Likelihood that a batch of files came from this source. */
export type DetectVerdict = "match" | "maybe" | "no"

export interface SubagentSourceAdapter {
  id: SubagentSourceId
  displayName: string
  /** i18n suffix under `settings.subagents.import.sources.<labelKey>`. */
  labelKey: string
  /** File extensions accepted by the file picker (".md", ".mdc", ".markdown"). */
  acceptedExtensions: string[]
  /** Heuristic — used by `detectSource` for the auto-detect option. */
  detect(input: ImportInput): DetectVerdict
  /** Parse all files. Files that don't match the source are silently skipped
   *  in the drafts list and surfaced as `errors` only when the file does
   *  match shape but fails (missing name, empty body, malformed YAML). */
  parse(input: ImportInput): ParseResult
}

export type ImportTarget = "subagent-template" | "character"
export type ImportMergeStrategy = "skip" | "overwrite" | "duplicate"

export interface ApplyImportArgs {
  drafts: SubagentImportDraft[]
  target: ImportTarget
  strategy: ImportMergeStrategy
}

export interface ApplyImportResult {
  imported: number
  skipped: number
  overwritten: number
  failed: Array<{ name: string; error: string }>
}
