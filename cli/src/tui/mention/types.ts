/**
 * Type surface for the composer's unified `@` mention system — file, skill, and
 * agent references in a single popup.
 *
 * Type-only module: TS strips it at runtime, so it is excluded from coverage
 * (matches `state/types.ts`). The runtime logic lives in `detector.ts`,
 * `providers.ts`, `accept.ts`, and `preprocess.ts`, each with a co-located test.
 */

/** What kind of object an `@` mention refers to. */
export type MentionKind = "file" | "skill" | "agent"

/** One selectable row in the {@link MentionPalette}. */
export interface MentionCandidate {
  kind: MentionKind
  /** File path, skill id, or agent id. */
  id: string
  /** Display name shown in the popup. */
  label: string
  /** Description or origin hint, shown muted next to the label. */
  hint?: string
  /** For skills: `skillOriginLabel()` result; for agents: `"agent"`. */
  origin?: string
  /** The exact string inserted into the buffer when this row is accepted. */
  insert: string
}

/**
 * The active `@` token under the cursor, classified into a popup mode. `null`
 * when the cursor is not in an `@` reference.
 */
export interface DetectedMention {
  /** Text after `@` (and after the `skill:` / `agent:` / `file:` prefix). */
  query: string
  /** Column where `@` begins on the current line. */
  start: number
  /**
   * Which candidate sources the popup should surface:
   *   - `mixed`  → files + skills + agents (bare `@`)
   *   - `skill`  → skills only (`@skill:`)
   *   - `agent`  → agents only (`@agent:`)
   *   - `file`   → files only (`@file:` or a path-shaped token)
   */
  mode: "mixed" | "skill" | "agent" | "file"
}
