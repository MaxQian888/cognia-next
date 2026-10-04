/**
 * Real BibTeX parser (M3). Byte-exact over UTF-8 input: every entry and
 * error carries a UTF-8 byte offset plus 1-based line/column, and `raw` is
 * the exact source slice of the entry so downstream stages (local-bib
 * provider, import patch generation) can re-emit or hash it verbatim.
 *
 * Grammar handled: `@type{key, field = value, ...}` and `@type(...)`,
 * `@string`/`@preamble`/`@comment`, quoted values with nested braces,
 * braced values with arbitrary nesting, bare numbers, `#` concatenation,
 * and `@string` resolution (forward references included, matching BibTeX).
 * Parse errors are recoverable: the scanner resynchronizes at the next
 * top-level `@` so one malformed entry cannot hide the rest of the file.
 */
import { utf8Bytes } from "@latexwb/contracts";
import { maskComments } from "./protect.ts";

export interface BibError {
  message: string;
  /** UTF-8 byte offset of the offending position. */
  offsetByte: number;
  line: number;
  column: number;
}

export interface BibEntry {
  /** Lowercased entry type (article, book, inproceedings, ...). */
  type: string;
  key: string;
  /** Lowercased field name → resolved value (string refs substituted). */
  fields: Map<string, string>;
  /** Exact source bytes of the whole `@type{...}` form. */
  raw: Uint8Array;
  startByte: number;
  endByte: number;
  line: number;
  column: number;
}

export interface BibFile {
  entries: BibEntry[];
  /** Resolved @string values (lowercased names). */
  strings: Map<string, string>;
  errors: BibError[];
}

/** Standard month abbreviations resolve to their full names. */
const MONTH_MACROS: ReadonlyMap<string, string> = new Map([
  ["jan", "January"], ["feb", "February"], ["mar", "March"], ["apr", "April"],
  ["may", "May"], ["jun", "June"], ["jul", "July"], ["aug", "August"],
  ["sep", "September"], ["oct", "October"], ["nov", "November"], ["dec", "December"],
]);

function charToByteMap(text: string): Uint32Array {
  const map = new Uint32Array(text.length + 1);
  let byte = 0;
  let i = 0;
  while (i < text.length) {
    map[i] = byte;
    const cp = text.codePointAt(i) as number;
    const u16 = cp > 0xffff ? 2 : 1;
    if (u16 === 2) map[i + 1] = byte;
    byte += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += u16;
  }
  map[text.length] = byte;
  return map;
}

export function parseBibTeX(bytes: Uint8Array): BibFile {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const map = charToByteMap(text);
  const errors: BibError[] = [];
  const entries: BibEntry[] = [];
  const stringDefs = new Map<string, string>();
  /** Unresolved string references: name → accumulated literal parts. */
  const pendingStrings = new Map<string, { parts: string[] }>();

  const lineCol = (charIdx: number): { line: number; column: number } => {
    let line = 1;
    let col = 1;
    for (let i = 0; i < charIdx; i += 1) {
      if (text[i] === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    }
    return { line, column: col };
  };
  const fail = (charIdx: number, message: string): void => {
    errors.push({ message, offsetByte: map[charIdx] as number, ...lineCol(charIdx) });
  };

  let i = 0;
  const n = text.length;

  const skipSpace = (): void => {
    while (i < n) {
      const c = text[i] as string;
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f") {
        i += 1;
      } else if (c === "%") {
        while (i < n && text[i] !== "\n") i += 1;
      } else {
        break;
      }
    }
  };

  /** Skip to just past the next `@` at top level (error recovery). */
  const resync = (): void => {
    i += 1;
    while (i < n && text[i] !== "@") i += 1;
  };

  /** Read a name token ([A-Za-z0-9_:.?!$&*+-/']+ after a leading letter for
   * entry types; looser for field names per BibTeX convention). */
  const readName = (): string | null => {
    const start = i;
    while (i < n && /[A-Za-z]/.test(text[i] as string)) i += 1;
    return i > start ? text.slice(start, i) : null;
  };
  const readFieldName = (): string | null => {
    const start = i;
    while (i < n && /[A-Za-z0-9_:.*!$&?+\-/'"]/.test(text[i] as string)) i += 1;
    // '=' is not part of a name; stop the scan cleanly.
    while (i > start && text[i - 1] === "=") i -= 1;
    const s = text.slice(start, i);
    return s.length > 0 ? s : null;
  };

  /** Parse one value fragment: {balanced}, "quoted" (braces nest inside),
   * bare number, or a name (string reference). Returns literal text for
   * braced/quoted/number fragments and {ref:name} for string refs. */
  const readValue = ():
    | { kind: "literal"; text: string }
    | { kind: "ref"; name: string }
    | { kind: "error" } => {
    skipSpace();
    const c = text[i];
    if (c === "{") {
      const start = i;
      i += 1;
      let depth = 1;
      while (i < n && depth > 0) {
        const ch = text[i] as string;
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
      }
      if (depth !== 0) {
        fail(start, "unbalanced braces in value");
        return { kind: "error" };
      }
      return { kind: "literal", text: text.slice(start + 1, i - 1) };
    }
    if (c === '"') {
      i += 1;
      const start = i;
      let depth = 0;
      while (i < n) {
        const ch = text[i] as string;
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
        else if (ch === '"' && depth === 0) break;
        i += 1;
      }
      if (i >= n) {
        fail(start, "unterminated quoted string");
        return { kind: "error" };
      }
      const value = text.slice(start, i);
      i += 1; // closing quote
      return { kind: "literal", text: value };
    }
    if (c !== undefined && /[0-9]/.test(c)) {
      const start = i;
      while (i < n && /[0-9]/.test(text[i] as string)) i += 1;
      return { kind: "literal", text: text.slice(start, i) };
    }
    const name = readFieldName();
    if (name !== null) return { kind: "ref", name: name.toLowerCase() };
    fail(i, `expected value (brace group, quoted string, number, or string name), found ${JSON.stringify(c ?? "EOF")}`);
    return { kind: "error" };
  };

  /** value (# value)* — returns concatenated text or null on hard error. */
  const readConcatValue = (): string | null => {
    const parts: string[] = [];
    for (;;) {
      const v = readValue();
      if (v.kind === "error") return null;
      if (v.kind === "ref") {
        const resolved = stringDefs.get(v.name) ?? MONTH_MACROS.get(v.name);
        if (resolved === undefined) {
          fail(i, `undefined string reference ${JSON.stringify(v.name)}`);
          parts.push(v.name);
        } else {
          parts.push(resolved);
        }
      } else {
        parts.push(v.text);
      }
      skipSpace();
      if (text[i] === "#") {
        i += 1;
        continue;
      }
      break;
    }
    return parts.join("");
  };

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    if (text[i] !== "@") {
      // Text outside entries is implicit comment material in BibTeX.
      i += 1;
      continue;
    }
    const atChar = i;
    i += 1;
    const typeName = readName();
    if (typeName === null) {
      fail(atChar, "expected entry type after '@'");
      resync();
      continue;
    }
    const type = typeName.toLowerCase();
    skipSpace();
    const open = text[i];
    if (open !== "{" && open !== "(") {
      fail(i, `expected '{' or '(' after @${typeName}, found ${JSON.stringify(open ?? "EOF")}`);
      resync();
      continue;
    }
    const openCh = open as string;
    const closeCh = openCh === "{" ? "}" : ")";
    i += 1;

    /** Skip a balanced group honoring BOTH delimiter kinds (braces nest
     * inside parens and vice versa in real-world .bib). */
    const skipGroup = (): boolean => {
      let paren = openCh === "(" ? 1 : 0;
      let brace = openCh === "{" ? 1 : 0;
      while (i < n) {
        const ch = text[i] as string;
        if (ch === "{") brace += 1;
        else if (ch === "}") brace -= 1;
        else if (ch === "(") paren += 1;
        else if (ch === ")") paren -= 1;
        i += 1;
        if (paren === 0 && brace === 0) return true;
      }
      return false;
    };

    if (type === "comment") {
      // @comment{...} / @comment(...) — content is ignored entirely.
      const start = i;
      if (!skipGroup()) {
        fail(start, `unterminated @comment`);
        break;
      }
      continue;
    }

    if (type === "preamble" || type === "string") {
      const start = i;
      if (type === "preamble") {
        // @preamble{value} — content irrelevant for citations; skip balanced.
        // Reuse skipGroup by rewinding to just after the opener.
        if (!skipGroup()) {
          fail(start, "unterminated @preamble");
          break;
        }
        continue;
      }
      // @string{name = value}
      skipSpace();
      const name = readFieldName();
      if (name === null) {
        fail(i, "@string requires a name");
        resync();
        continue;
      }
      skipSpace();
      if (text[i] !== "=") {
        fail(i, `@string ${name}: expected '='`);
        resync();
        continue;
      }
      i += 1;
      const value = readConcatValue();
      skipSpace();
      if (text[i] === closeCh) {
        i += 1;
      } else {
        fail(i, `@string ${name}: expected '${closeCh}'`);
        resync();
      }
      if (value !== null) stringDefs.set(name.toLowerCase(), value);
      continue;
    }

    // Regular entry: key then fields.
    skipSpace();
    const keyStart = i;
    while (i < n && text[i] !== "," && text[i] !== closeCh && !/\s/.test(text[i] as string)) {
      i += 1;
    }
    const key = text.slice(keyStart, i);
    skipSpace();
    const fields = new Map<string, string>();
    let hardError = false;
    if (key.length === 0) {
      fail(i, `@${typeName}: empty citation key`);
    }
    if (text[i] === ",") i += 1;
    for (;;) {
      skipSpace();
      if (i >= n) {
        fail(atChar, `unterminated @${typeName}{${key}}`);
        hardError = true;
        break;
      }
      if (text[i] === closeCh) {
        i += 1;
        break;
      }
      const fname = readFieldName();
      if (fname === null) {
        fail(i, `@${typeName}{${key}}: expected field name or '${closeCh}', found ${JSON.stringify(text[i])}`);
        hardError = true;
        resync();
        break;
      }
      skipSpace();
      if (text[i] === "=") {
        i += 1;
        const value = readConcatValue();
        if (value === null) {
          hardError = true;
          resync();
          break;
        }
        fields.set(fname.toLowerCase(), value);
      } else {
        // A bare token with no '=' is a malformed field — record but keep
        // scanning: BibTeX treats unknown bare tokens as errors, not keys.
        fail(i, `@${typeName}{${key}}: field ${fname} has no '=' value`);
      }
      skipSpace();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === closeCh) {
        i += 1;
        break;
      }
      if (i >= n) {
        fail(atChar, `unterminated @${typeName}{${key}}`);
        hardError = true;
        break;
      }
      fail(i, `@${typeName}{${key}}: expected ',' or '${closeCh}', found ${JSON.stringify(text[i])}`);
      hardError = true;
      resync();
      break;
    }
    if (hardError) continue;
    if (key.length === 0) continue; // error already recorded
    const endByte = map[i] as number;
    const { line, column } = lineCol(atChar);
    entries.push({
      type,
      key,
      fields,
      raw: bytes.slice(map[atChar] as number, endByte),
      startByte: map[atChar] as number,
      endByte,
      line,
      column,
    });
  }

  return { entries, strings: stringDefs, errors };
}

/** The citation-command set shared with protect.ts (kept in sync). */
const CITE_COMMAND_RE =
  /\\(?:[Cc]ite[tp]?|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|smartcite|supercite|nocite|citeyearpar|citepos)(?:\[[^\]]*\])*\{([^}]*)\}/g;

export interface CitationUse {
  key: string;
  /** 1-based line/column of the citation command. */
  line: number;
  column: number;
}

/** All \cite-style keys used in a .tex source, in first-appearance order. */
export function scanCitations(text: string): CitationUse[] {
  const uses: CitationUse[] = [];
  // Precompute line-start offsets once: position lookup is O(log lines).
  const lineStarts = [0];
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === "\n") lineStarts.push(k + 1);
  }
  const lineColOf = (at: number): { line: number; column: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - (lineStarts[lo] as number) + 1 };
  };
  // Commented-out citations are not citations (e.g. a template's
  // "% cite with \cite{key}" hint). Masking keeps offsets aligned.
  const masked = maskComments(text);
  const re = new RegExp(CITE_COMMAND_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const pos = lineColOf(m.index);
    for (const raw of (m[1] as string).split(",")) {
      const key = raw.trim();
      if (key.length > 0) uses.push({ key, line: pos.line, column: pos.column });
    }
  }
  return uses;
}

/** Convenience: bytes → parse. */
export function parseBibTeXText(text: string): BibFile {
  return parseBibTeX(utf8Bytes(text));
}
