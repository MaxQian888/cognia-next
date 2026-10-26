/**
 * Text-anchored edit resolution (workbench ADR-0007): locate the exact text
 * an agent quotes (`oldText`) inside a file instead of trusting byte offsets
 * it computed itself — a live run once produced "arere" from a 2-byte slip.
 * Ambiguity is never guessed: `oldText` must match exactly once unless
 * `occurrence` (1-based) picks one. Matches may overlap (the search resumes
 * one code unit after each hit).
 *
 * Failures come back as data with an explanatory message — never thrown —
 * so each host maps them to its own error type. A host typically prefixes
 * the message with where the edit came from, e.g. the workbench throws
 * `INVALID_REQUEST` with `"<where>: <message>"`.
 */

export type FindAnchorErrorCode = "NOT_FOUND" | "AMBIGUOUS" | "OCCURRENCE_OUT_OF_RANGE";

export type FindAnchorResult =
  | {
      ok: true;
      /** UTF-16 code-unit index of the chosen match in `text`. */
      index: number;
      /** Total number of (possibly overlapping) matches of `oldText`. */
      matches: number;
    }
  | {
      ok: false;
      code: FindAnchorErrorCode;
      /** Human/agent-facing explanation, without a location prefix. */
      message: string;
      /** Number of matches found (0 for NOT_FOUND). */
      matches: number;
      /** AMBIGUOUS only: 1-based line numbers of the first (up to 10) matches. */
      lines?: number[];
    };

export interface FindAnchorOptions {
  /**
   * How the searched text is named in the NOT_FOUND message
   * ("oldText not found in <within>"). Default: "the base snapshot".
   */
  within?: string;
}

/** Most match line numbers listed in an AMBIGUOUS message. */
const MAX_LISTED_LINES = 10;

/** 1-based line number of a UTF-16 index. */
export function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** Every (possibly overlapping) UTF-16 index at which `needle` occurs. */
export function allIndexes(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Find the unique (or `occurrence`-th, 1-based) exact match of `oldText` in
 * `text`. `index` is a JS string (UTF-16) index; use `utf16RangeToUtf8(text,
 * index, index + oldText.length)` for UTF-8 byte offsets.
 *
 * Failure messages:
 * - NOT_FOUND: hints at CRLF line endings, and whether a whitespace-insensitive
 *   match exists (the agent re-flowed or paraphrased the text);
 * - OCCURRENCE_OUT_OF_RANGE: occurrence larger than the match count;
 * - AMBIGUOUS: several matches and no occurrence — lists their lines.
 *
 * Preconditions, validated by callers at their schema boundary (the
 * workbench contract declares `oldText.minLength: 1`, `occurrence.minimum:
 * 1`) and deliberately not re-checked here: `oldText` must be non-empty (an
 * empty needle never terminates the overlapping search) and `occurrence`
 * must be an integer >= 1.
 */
export function findAnchor(
  text: string,
  oldText: string,
  occurrence?: number,
  options: FindAnchorOptions = {},
): FindAnchorResult {
  const within = options.within ?? "the base snapshot";
  const hits = allIndexes(text, oldText);
  if (hits.length === 0) {
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    const loose = squash(text).includes(squash(oldText));
    const crlf = text.includes("\r\n") && !oldText.includes("\r\n") && oldText.includes("\n");
    return {
      ok: false,
      code: "NOT_FOUND",
      matches: 0,
      message:
        `oldText not found in ${within}` +
        (crlf ? " (the file uses CRLF line endings)" : "") +
        (loose
          ? " — a whitespace-insensitive match exists; re-read the file and copy the exact text including line breaks"
          : " — re-read the current source; it may have changed or the text was paraphrased"),
    };
  }
  if (occurrence !== undefined) {
    if (occurrence > hits.length) {
      return {
        ok: false,
        code: "OCCURRENCE_OUT_OF_RANGE",
        matches: hits.length,
        message: `occurrence ${occurrence} requested but oldText occurs ${hits.length} time(s)`,
      };
    }
    return { ok: true, index: hits[occurrence - 1] as number, matches: hits.length };
  }
  if (hits.length > 1) {
    const lines = hits.slice(0, MAX_LISTED_LINES).map((i) => lineOfIndex(text, i));
    return {
      ok: false,
      code: "AMBIGUOUS",
      matches: hits.length,
      lines,
      message:
        `oldText is ambiguous — it occurs ${hits.length} times (lines ${lines.join(", ")}${hits.length > MAX_LISTED_LINES ? ", …" : ""}); ` +
        "include more surrounding text to make it unique, or set occurrence (1-based)",
    };
  }
  return { ok: true, index: hits[0] as number, matches: 1 };
}
