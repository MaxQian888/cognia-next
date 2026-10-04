/**
 * TeX/Tectonic log diagnostics — a line-oriented state machine, not a grep
 * for the first "Error". It tracks the `(`/`)` file stack to attribute each
 * diagnostic to the file actually being read, handles TeX's `l.<n>` line
 * anchors and wrapped continuations, and emits schema Diagnostics with
 * 1-based rawLogRange and a content-derived causeId (stable across runs —
 * timestamps never enter the fingerprint).
 *
 * File stack: every `(` pushes an entry — a real file when the token looks
 * like (or resolves to) a file, otherwise a placeholder — so each `)` pops
 * exactly its own opener (the LaTeX Workshop / pplatex technique). Text that
 * TeX echoes verbatim and that may hold unbalanced parens or `[<n>` tokens
 * (error context, box contents, runaway text, \write-style messages) is
 * never scanned for stack or page transitions.
 *
 * Honesty rules: unknown line/column stay null (never guessed), unparsed
 * error blocks still surface as needs-review-style diagnostics with
 * confidence "unknown" rather than being dropped. Page numbers derived from
 * shipped-page tracking are estimates and carry confidence "heuristic".
 */
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import {
  sha256Hex,
  type Diagnostic,
  type SourceLocation,
} from "@latexwb/contracts";

export interface ParsedLog {
  diagnostics: Diagnostic[];
  /** True when the log ended without a clean "Output written" line. */
  noOutputWritten: boolean;
  /** PDF path reported by "Output written on ...", if any. */
  outputWrittenPath: string | null;
  /** Page count from the same "Output written on … (N pages" line. */
  pageCount: number | null;
}

export interface ParseTexLogOptions {
  /**
   * Project-relative paths of the snapshot's TeX sources. When given, a log
   * file token resolves to a project file if it equals one of these, or
   * token + ".tex" does (Tectonic logs `\input` files without the
   * extension), and the diagnostic carries that exact project path.
   * Diagnostics whose innermost open file is not a project file (e.g. an
   * error raised inside a .sty) keep that attribution but are downgraded to
   * confidence "heuristic".
   */
  projectPaths?: readonly string[];
  /**
   * Project-relative directory the engine ran in ("" or omitted = project
   * root). Relative log paths are resolved against it before matching
   * `projectPaths` (entry-parent targets run inside the entry's folder).
   */
  baseDir?: string;
  /** Absolute engine working directory; stripped from absolute log paths. */
  workDir?: string;
}

interface FileEntry {
  kind: "file";
  /** Raw token as it appears in the log (may be ./relative or absolute). */
  raw: string;
  /** Attributed path (exact project path when resolved). */
  path: string;
  /** True when the token resolved against `projectPaths`. */
  project: boolean;
}

interface PlaceholderEntry {
  kind: "placeholder";
  raw: string;
}

type StackEntry = FileEntry | PlaceholderEntry;

const MAX_MESSAGE = 400;
/** TeX's max_print_line: log lines are hard-wrapped after this many chars. */
const TEX_WRAP_COLUMN = 79;

function normalizeLogPath(raw: string, workDirPrefix: string | null): string {
  let p = raw.trim();
  if (workDirPrefix !== null && p.startsWith(workDirPrefix)) {
    p = p.slice(workDirPrefix.length);
  }
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.slice(1); // keep it project-relative
  return p;
}

/**
 * A line of exactly max_print_line characters was (almost certainly) hard
 * wrapped by TeX. XeTeX counts code points, pdfTeX counts bytes.
 */
function isWrapLength(line: string): boolean {
  if (line.length === TEX_WRAP_COLUMN) return true;
  if (line.length < TEX_WRAP_COLUMN / 4 || line.length > TEX_WRAP_COLUMN * 2) return false;
  return [...line].length === TEX_WRAP_COLUMN || Buffer.byteLength(line, "utf8") === TEX_WRAP_COLUMN;
}

function hasExtension(token: string): boolean {
  return /\.[A-Za-z][A-Za-z0-9]{1,6}$/.test(token);
}

const PATH_CHARS = /^[\p{L}\p{N}_.\-/+~@]+$/u;

function looksLikeFile(token: string): boolean {
  if (token.length === 0) return false;
  if (/^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(token)) return true;
  if (hasExtension(token)) return true;
  // Tectonic prints `\input{sections/intro}` as `(sections/intro`.
  return token.includes("/") && /[A-Za-z]/.test(token) && PATH_CHARS.test(token);
}

class LogPathResolver {
  private readonly projects: ReadonlySet<string> | null;
  private readonly baseDir: string;
  private readonly workDir: string | null;

  constructor(options: ParseTexLogOptions | undefined) {
    this.projects =
      options?.projectPaths === undefined
        ? null
        : new Set(options.projectPaths.map((p) => p.normalize("NFC").replace(/^\.\//, "")));
    const base = (options?.baseDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    this.baseDir = base === "." ? "" : base.replace(/^\.\//, "");
    const wd = options?.workDir?.replace(/\/+$/, "") ?? "";
    this.workDir = wd.length > 0 ? wd : null;
  }

  get hasProjects(): boolean {
    return this.projects !== null;
  }

  /** Exact project path for a log token, or null. */
  resolveProject(raw: string): string | null {
    if (this.projects === null) return null;
    let p = raw.trim().normalize("NFC");
    if (p.length === 0) return null;
    if (this.workDir !== null && p.startsWith(`${this.workDir}/`)) {
      p = p.slice(this.workDir.length + 1);
    } else if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
      return null;
    }
    p = posix.normalize(this.baseDir.length > 0 ? `${this.baseDir}/${p}` : p);
    if (p === ".." || p.startsWith("../") || p.startsWith("/")) return null;
    p = p.replace(/^\.\//, "");
    if (this.projects.has(p)) return p;
    if (this.projects.has(`${p}.tex`)) return `${p}.tex`;
    return null;
  }

  displayPath(raw: string): string {
    return normalizeLogPath(raw, this.workDir === null ? null : `${this.workDir}/`);
  }

  classify(raw: string): StackEntry {
    const project = this.resolveProject(raw);
    if (project !== null) return { kind: "file", raw, path: project, project: true };
    if (looksLikeFile(raw)) {
      return { kind: "file", raw, path: this.displayPath(raw), project: false };
    }
    return { kind: "placeholder", raw };
  }
}

interface ScanState {
  stack: StackEntry[];
  /** Number of the last page TeX started shipping out (`[<n>`); 0 = none. */
  lastPage: number;
  /** Stack index of a file token cut by the 79-column wrap, if any. */
  wrapIndex: number | null;
}

/**
 * Decide whether the next line's leading chunk continues a file token that
 * TeX wrapped at column 79. Conservative: prefer a project match, never
 * glue onto a token that already looks complete unless the result still
 * looks like a file.
 */
function shouldJoinWrapped(raw: string, chunk: string, resolver: LogPathResolver): boolean {
  if (!PATH_CHARS.test(chunk)) return false;
  const joined = raw + chunk;
  if (resolver.hasProjects) {
    if (resolver.resolveProject(joined) !== null) return true;
    if (resolver.resolveProject(raw) !== null) return false;
  }
  return !hasExtension(raw) || hasExtension(joined);
}

const PAGE_TOKEN = /\[(\d+)/y;

/** Scan one plain log line for file-stack and shipped-page transitions. */
function scanLine(line: string, st: ScanState, resolver: LogPathResolver): void {
  let i = 0;
  if (st.wrapIndex !== null) {
    const idx = st.wrapIndex;
    st.wrapIndex = null;
    const entry = st.stack[idx];
    const chunk = /^[^\s()"]+/.exec(line)?.[0];
    if (
      entry !== undefined &&
      idx === st.stack.length - 1 &&
      chunk !== undefined &&
      shouldJoinWrapped(entry.raw, chunk, resolver)
    ) {
      st.stack[idx] = resolver.classify(entry.raw + chunk);
      i = chunk.length;
      if (i === line.length && isWrapLength(line)) st.wrapIndex = idx;
    }
  }
  while (i < line.length) {
    const ch = line[i];
    if (ch === "(") {
      let j = i + 1;
      let raw: string;
      if (line[j] === '"') {
        const close = line.indexOf('"', j + 1);
        raw = line.slice(j + 1, close === -1 ? line.length : close);
        j = close === -1 ? line.length : close + 1;
      } else {
        while (j < line.length && !/[\s()]/.test(line[j] as string)) j += 1;
        raw = line.slice(i + 1, j);
      }
      st.stack.push(resolver.classify(raw));
      if (j === line.length && raw.length > 0 && isWrapLength(line)) {
        st.wrapIndex = st.stack.length - 1;
      }
      i = j;
      continue;
    }
    if (ch === ")") {
      st.stack.pop();
      i += 1;
      continue;
    }
    if (ch === "[" && (i === 0 || /[\s()\]]/.test(line[i - 1] as string))) {
      PAGE_TOKEN.lastIndex = i;
      const m = PAGE_TOKEN.exec(line);
      if (m !== null) {
        st.lastPage = Number.parseInt(m[1] as string, 10);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
}

function currentAttribution(
  st: ScanState,
  fallback: string,
): { path: string; project: boolean } {
  for (let k = st.stack.length - 1; k >= 0; k -= 1) {
    const e = st.stack[k];
    if (e?.kind === "file") return { path: e.path, project: e.project };
  }
  return { path: fallback, project: true };
}

function causeId(code: string, source: string | null, token: string): string {
  return `c${sha256Hex(`${code}|${source ?? ""}|${token}`).slice(0, 24)}`;
}

function makeDiagnostic(partial: {
  code: string;
  severity: Diagnostic["severity"];
  message: string;
  path: string | null;
  line: number | null;
  column?: number | null;
  page?: number | null;
  causeToken: string;
  rawLogRange: { startLine: number; endLine: number } | null;
  confidence: Diagnostic["confidence"];
}): Diagnostic {
  const line = partial.line !== null && partial.line >= 1 ? partial.line : null;
  const page = partial.page !== undefined && partial.page !== null && partial.page >= 1
    ? partial.page
    : null;
  const source: SourceLocation | null =
    partial.path === null
      ? null
      : { path: partial.path, line, column: partial.column ?? null };
  return {
    code: partial.code,
    severity: partial.severity,
    message: partial.message.slice(0, MAX_MESSAGE),
    source,
    page,
    causeId: causeId(partial.code, partial.path, `${line ?? ""}|${partial.causeToken}`),
    evidenceArtifactIds: [],
    rawLogRange: partial.rawLogRange,
    confidence: partial.confidence,
  };
}

/** Original text first, then context and hint; the base yields on overflow. */
function composeMessage(base: string, context: string, hint: string | null): string {
  const ctx = context.length > 0 ? ` — context: ${context}` : "";
  const tail = hint !== null && hint.length > 0 ? ` — hint: ${hint}` : "";
  const room = MAX_MESSAGE - ctx.length - tail.length;
  const head = base.length <= room ? base : `${base.slice(0, Math.max(0, room - 1))}…`;
  return `${head}${ctx}${tail}`;
}

/** Trailing control sequence of a TeX context line (`l.12 text \foo`). */
function trailingControlSequence(text: string): string | null {
  return /(\\(?:[A-Za-z@]+|[^A-Za-z@\s]))\s*$/.exec(text)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

interface ErrorBlock {
  /** Offending macro named by TeX's context, if determinable. */
  macro: string | null;
}

interface BangRule {
  code: string;
  severity: Diagnostic["severity"];
  match: RegExp;
  token?: (m: RegExpExecArray) => string;
  hint?: (m: RegExpExecArray, block: ErrorBlock) => string | null;
}

const PACKAGE_HINT =
  "the package is not in the pinned offline bundle, or its name is misspelled";
const PACKAGE_FILE = /\.(sty|cls|def|clo|fd|ldf)$/i;
const BRACES_HINT = "unbalanced braces: a } has no matching {";

const BANG_RULES: BangRule[] = [
  {
    code: "UNDEFINED_CONTROL_SEQUENCE",
    severity: "error",
    match: /^! Undefined control sequence\./,
    token: () => "",
    hint: (_m, block) =>
      block.macro !== null
        ? `undefined macro: ${block.macro} (misspelled, or the package that defines it is not loaded)`
        : "a command is misspelled, or the package that defines it is not loaded",
  },
  {
    code: "MISSING_PACKAGE",
    severity: "error",
    match: /^! LaTeX Error: File `([^']+\.(sty|cls|def|clo|fd|ldf|ltx|dtx|ins|cfg))' not found/i,
    token: (m) => m[1] ?? "",
    hint: () => PACKAGE_HINT,
  },
  {
    code: "MISSING_ASSET",
    severity: "error",
    match: /^! (?:LaTeX|Package [A-Za-z]+) Error: File `([^']+)' not found/i,
    token: (m) => m[1] ?? "",
    hint: (m) => (m[1] !== undefined && PACKAGE_FILE.test(m[1]) ? PACKAGE_HINT : null),
  },
  {
    code: "MISSING_FONT",
    severity: "error",
    match: /^! (?:Package fontspec|fontspec|Package (?:xeCJK|ctex|unicode-math)).*[Ff]ont.*(?:not found|cannot be found|cannot be loaded)/,
    token: () => "",
  },
  {
    code: "MISSING_FONT",
    severity: "error",
    match: /^! Font [^=]*=(\S+) not found/i,
    token: (m) => m[1] ?? "",
  },
  {
    code: "MATH_MODE_ERROR",
    severity: "error",
    match: /^! Missing \$ inserted\./,
    hint: () =>
      "a math-only command or ^/_ was used outside math mode, or a $ is unbalanced",
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Extra \}, or forgotten \$\./,
    hint: () => `${BRACES_HINT}, or a math $ is missing`,
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Too many \}'s\./,
    hint: () => BRACES_HINT,
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Missing \} inserted\./,
    hint: () => "unbalanced braces: a { is never closed (often inside math or a command argument)",
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Extra alignment tab has been changed to \\cr\./,
    hint: () => "a table row has more & cells than the tabular column spec declares",
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Misplaced alignment tab character &\./,
    hint: () => "& used outside a tabular/align environment; write \\& for a literal ampersand",
  },
  {
    code: "UNDEFINED_ENVIRONMENT",
    severity: "error",
    match: /^! LaTeX Error: Environment (\S+) undefined\./,
    token: (m) => m[1] ?? "",
    hint: (m) =>
      `the package that defines environment ${m[1] ?? ""} is not loaded, or its name is misspelled`,
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! LaTeX Error: Missing \\begin\{document\}\./,
    hint: () =>
      "text or a stray character appears before \\begin{document}, often in the preamble",
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! Paragraph ended before (\\\S+) was complete\./,
    token: (m) => m[1] ?? "",
    hint: (m) => `a blank line or a missing } inside the argument of ${m[1] ?? "a command"}`,
  },
  {
    code: "SYNTAX_ERROR",
    severity: "error",
    match: /^! File ended while scanning use of (\\[^\s.]+)/,
    token: (m) => m[1] ?? "",
    hint: (m) => `a missing } in the argument of ${m[1] ?? "a command"} (the file ended first)`,
  },
  {
    code: "ENGINE_MISMATCH",
    severity: "error",
    match: /^! .*?(?:requires|need).*?(XeTeX|LuaTeX|pdfTeX|XeLaTeX|LuaLaTeX|pdfLaTeX)/i,
    token: (m) => m[1] ?? "",
  },
  {
    code: "MISMATCHED_ENVIRONMENT",
    severity: "error",
    match: /^! LaTeX Error: \\begin\{([^}]*)\} on input line (\d+) ended by \\end\{([^}]*)\}/,
    token: (m) => `${m[1] ?? ""}|${m[3] ?? ""}`,
  },
  {
    code: "BIBLIOGRAPHY_FAILURE",
    severity: "error",
    match: /^! .*?(?:biblatex|BibTeX|biber).*(?:error|failed|cannot|couldn't)/i,
    token: () => "",
  },
];

interface WarningRule {
  code: string;
  severity: Diagnostic["severity"];
  match: RegExp;
  token?: (m: RegExpExecArray) => string;
  /** Capture group holding an explicit page number from the message. */
  pageGroup?: number;
  /** Estimate the page from shipped-page tracking (box/float warnings). */
  estimatePage?: boolean;
}

/** Rules applied to a whole (continuation-joined) LaTeX message block. */
const MESSAGE_RULES: WarningRule[] = [
  {
    code: "RERUN_NEEDED",
    severity: "info",
    match: /LaTeX Warning: Label\(s\) may have changed\. Rerun/,
    token: () => "labels",
  },
  {
    code: "UNDEFINED_REFERENCE",
    severity: "warning",
    match: /LaTeX Warning: Reference `([^']+)' on page (\d+) undefined/,
    token: (m) => m[1] ?? "",
    pageGroup: 2,
  },
  {
    code: "UNDEFINED_CITATION",
    severity: "warning",
    match: /(?:LaTeX|Package natbib|Package biblatex) Warning: Citation [`']([^']+)' on page (\d+) undefined/,
    token: (m) => m[1] ?? "",
    pageGroup: 2,
  },
  {
    code: "DUPLICATE_LABEL",
    severity: "warning",
    match: /LaTeX Warning: Label `([^']+)' multiply defined/,
    token: (m) => m[1] ?? "",
  },
  {
    code: "FONT_SUBSTITUTION",
    severity: "warning",
    match: /LaTeX Font Warning: Font shape `([^']+)' undefined/,
    token: (m) => m[1] ?? "",
  },
  {
    code: "FLOAT_TOO_LARGE",
    severity: "warning",
    match: /LaTeX Warning: Float too large for page(?: by ([\d.]+pt))?/,
    token: (m) => m[1] ?? "",
    estimatePage: true,
  },
  {
    code: "FLOAT_SPECIFIER",
    severity: "info",
    match: /LaTeX Warning: `([^']+)' float specifier changed to `([^']+)'/,
    token: (m) => `${m[1] ?? ""}->${m[2] ?? ""}`,
    estimatePage: true,
  },
];

const GLYPH_RE = /^Missing character: There is no (\S+) (?:.* )?in font/;

/**
 * `\write`-style message lines (LaTeX/package/class warnings and infos,
 * \ProvidesFile banners). TeX always emits these on lines of their own, so
 * they never carry file-stack transitions — and they echo user text (labels,
 * hyperref tokens) that may contain unbalanced parens.
 */
const MESSAGE_START =
  /^(?:(?:LaTeX|Package|Class|Module)(?: [^\s:]+)? (?:Warning|Info)|File|Package|Document Class|Language):/;

/** Box report line; its display lines follow up to the next blank line. */
const BOX_RE =
  /^(Overfull|Underfull|Tight|Loose) \\([hv])box \(([^)]*)\)(?: (?:in (?:paragraph|alignment) at lines (\d+)--(\d+)|detected at line (\d+)|has occurred while \\output is active))?/;

const RUNAWAY_RE = /^Runaway (?:argument|definition|preamble|text)\?\s*$/;

type Continuation = "wrap" | "indent" | null;

/** Is `next` a continuation of the message line `prev`? */
function messageContinuation(prev: string, next: string): Continuation {
  if (next.trim().length === 0) return null;
  if (/^\([^()\s]+\)\s{2,}\S/.test(next)) return "indent"; // (Font)   ...
  if (/^\s{4,}\S/.test(next)) return "indent"; // \MessageBreak padding
  // \write ends with print_ln, so a completed 79-char message is followed by
  // a blank line; a non-blank line after one is its wrapped remainder.
  if (isWrapLength(prev)) return "wrap";
  return null;
}

/** Could `next` be the wrapped remainder of an `!` error line? */
function isErrorWrapContinuation(next: string): boolean {
  if (next.trim().length === 0) return false;
  if (/^(?:\s|l\.\d|<|!)/.test(next)) return false;
  if (/^\\\S+\s(?:.*->|\.\.\.)/.test(next)) return false; // macro context line
  return true;
}

/**
 * Parse a TeX-family log (tectonic -keep-logs output, or latexmk's .log).
 * `entryRelPath` is the root document relative path used as fallback when
 * the file stack is empty. `options` enables project-relative attribution
 * (see ParseTexLogOptions); without it behavior is backward compatible.
 */
export function parseTexLog(
  logText: string,
  entryRelPath: string,
  options?: ParseTexLogOptions,
): ParsedLog {
  const lines = logText.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const at = (i: number): string => lines[i] ?? "";
  const diagnostics: Diagnostic[] = [];
  const resolver = new LogPathResolver(options);
  const st: ScanState = { stack: [], lastPage: 0, wrapIndex: null };
  const fallbackPath = normalizeLogPath(entryRelPath, null);
  let noOutputWritten = false;
  let outputWrittenPath: string | null = null;
  let pageCount: number | null = null;
  const seen = new Set<string>();

  const push = (d: Diagnostic): void => {
    const key = `${d.code}|${d.source?.path ?? ""}|${d.source?.line ?? ""}|${d.rawLogRange?.startLine ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(d);
  };

  /** Confidence after the project-attribution downgrade. */
  const attributed = (
    confidence: Diagnostic["confidence"],
    project: boolean,
  ): Diagnostic["confidence"] =>
    resolver.hasProjects && !project && confidence === "certain" ? "heuristic" : confidence;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = at(idx);
    const lineNo = idx + 1;

    if (/^No pages of output/i.test(line)) {
      noOutputWritten = true;
      st.wrapIndex = null;
      continue;
    }
    const outMatch = /^Output written on (.+?) \((\d+) pages?/i.exec(line);
    if (outMatch !== null) {
      outputWrittenPath = outMatch[1] ?? null;
      pageCount = Number.parseInt(outMatch[2] as string, 10);
      st.wrapIndex = null;
      continue;
    }

    // ---- `!` error blocks ---------------------------------------------
    if (line.startsWith("!")) {
      st.wrapIndex = null;
      const here = currentAttribution(st, fallbackPath);
      // Re-join an error line TeX wrapped at column 79.
      let text = line;
      let last = idx;
      while (isWrapLength(at(last)) && last + 1 < lines.length && isErrorWrapContinuation(at(last + 1))) {
        last += 1;
        text += at(last);
      }
      // Tectonic may double the marker ("! ! LaTeX Error: ...").
      const bang = text.replace(/^!(?:\s*!)*\s*/, "! ");
      // Find the `l.<n>` anchor within the next few lines (context block).
      let anchorLine: number | null = null;
      let anchorIdx = -1;
      let contextToken = "";
      for (let j = last + 1; j < Math.min(lines.length, last + 12); j += 1) {
        const m = /^l\.(\d+)\s*(.*)$/.exec(at(j));
        if (m !== null) {
          anchorLine = Number.parseInt(m[1] as string, 10);
          anchorIdx = j;
          contextToken = (m[2] ?? "").trim().slice(0, 80);
          break;
        }
        if (at(j).startsWith("!")) break;
      }
      const endLine = anchorIdx === -1 ? last + 1 : anchorIdx + 1;
      // The offending macro ends TeX's top context line (`<recently read>
      // \foo`, `\mac ->\foo`, or `l.12 text \foo`).
      const block: ErrorBlock = {
        macro:
          trailingControlSequence(at(last + 1)) ??
          (anchorIdx === -1 ? null : trailingControlSequence(at(anchorIdx))),
      };

      let matched = false;
      for (const rule of BANG_RULES) {
        const m = rule.match.exec(bang);
        if (m === null) continue;
        matched = true;
        // MISSING_ASSET vs MISSING_PACKAGE split: style/class files are
        // packages, everything else is an asset.
        let code = rule.code;
        if (code === "MISSING_ASSET" && m[1] !== undefined && PACKAGE_FILE.test(m[1])) {
          code = "MISSING_PACKAGE";
        }
        push(
          makeDiagnostic({
            code,
            severity: rule.severity,
            message: composeMessage(bang.slice(2).trim(), contextToken, rule.hint?.(m, block) ?? null),
            path: here.path,
            line: anchorLine,
            causeToken: `${text.trim()}|${contextToken}|${rule.token?.(m) ?? ""}`,
            rawLogRange: { startLine: lineNo, endLine },
            confidence: attributed(anchorLine === null ? "heuristic" : "certain", here.project),
          }),
        );
        break;
      }
      if (!matched) {
        // Unknown error block: keep the raw text, mark confidence unknown.
        push(
          makeDiagnostic({
            code: "TEX_ERROR",
            severity: "error",
            message: bang.slice(2).trim() || "unparsed TeX error",
            path: here.path,
            line: anchorLine,
            causeToken: text.trim(),
            rawLogRange: { startLine: lineNo, endLine },
            confidence: "unknown",
          }),
        );
      }
      // Context lines echo source text (unbalanced parens and all): skip
      // them for stack scanning, through the after-context of `l.<n>`.
      let skipTo = last;
      if (anchorIdx !== -1) {
        skipTo = anchorIdx;
        const after = at(anchorIdx + 1);
        if (anchorIdx + 1 < lines.length && /^\s/.test(after)) skipTo = anchorIdx + 1;
      }
      idx = skipTo;
      continue;
    }

    // ---- runaway text: the echoed source line is not log structure -----
    if (RUNAWAY_RE.test(line)) {
      st.wrapIndex = null;
      if (idx + 1 < lines.length && !at(idx + 1).startsWith("!")) idx += 1;
      continue;
    }

    // ---- box reports ----------------------------------------------------
    const box = BOX_RE.exec(line);
    if (box !== null) {
      st.wrapIndex = null;
      // The box display (typeset text: "(see", "[1]") runs to a blank line.
      let end = idx;
      for (let j = idx + 1; j < lines.length && j <= idx + 200; j += 1) {
        const l = at(j);
        if (l.trim().length === 0 || l.startsWith("!") || BOX_RE.test(l) || MESSAGE_START.test(l)) break;
        end = j;
      }
      const kind = box[1] as string;
      if (kind === "Overfull" || kind === "Underfull") {
        const here = currentAttribution(st, fallbackPath);
        const detail = box[3] ?? "";
        const firstLine = box[4] ?? box[6];
        const overfull = kind === "Overfull";
        push(
          makeDiagnostic({
            code: overfull ? "OVERFULL_BOX" : "UNDERFULL_BOX",
            severity: overfull ? "warning" : "info",
            message: line.trim(),
            path: here.path,
            line: firstLine === undefined ? null : Number.parseInt(firstLine, 10),
            page: st.lastPage + 1,
            causeToken: overfull ? (/^([\d.]+)pt/.exec(detail)?.[1] ?? detail) : detail,
            rawLogRange: { startLine: lineNo, endLine: end + 1 },
            confidence: "heuristic",
          }),
        );
      }
      idx = end;
      continue;
    }

    // ---- LaTeX/package message blocks ----------------------------------
    if (MESSAGE_START.test(line)) {
      st.wrapIndex = null;
      let text = line;
      let end = idx;
      for (let j = idx + 1; j < lines.length && j <= idx + 20; j += 1) {
        const kind = messageContinuation(at(j - 1), at(j));
        if (kind === null) break;
        text = kind === "wrap"
          ? `${text}${at(j)}`
          : `${text} ${at(j).replace(/^\([^()\s]+\)/, "").trim()}`;
        end = j;
      }
      for (const rule of MESSAGE_RULES) {
        const m = rule.match.exec(text);
        if (m === null) continue;
        const here = currentAttribution(st, fallbackPath);
        const inputLines = [...text.matchAll(/on input line (\d+)/g)];
        const inputLine = inputLines.length > 0
          ? Number.parseInt(inputLines[inputLines.length - 1]?.[1] as string, 10)
          : null;
        const page = rule.pageGroup !== undefined
          ? Number.parseInt(m[rule.pageGroup] as string, 10)
          : rule.estimatePage === true
            ? st.lastPage + 1
            : null;
        push(
          makeDiagnostic({
            code: rule.code,
            severity: rule.severity,
            message: text.trim(),
            path: here.path,
            line: inputLine,
            page,
            causeToken: `${rule.token?.(m) ?? ""}`,
            rawLogRange: { startLine: lineNo, endLine: end + 1 },
            confidence: "heuristic",
          }),
        );
        break;
      }
      idx = end;
      continue;
    }

    // ---- missing glyphs (single diagnostic line) ------------------------
    const glyph = GLYPH_RE.exec(line);
    if (glyph !== null) {
      st.wrapIndex = null;
      const here = currentAttribution(st, fallbackPath);
      push(
        makeDiagnostic({
          code: "MISSING_GLYPH",
          severity: "warning",
          // "…in font nullfont" is not a missing glyph: text was typeset
          // where no font is selected (a stray character inside a length,
          // a tabular preamble, a TikZ picture or beamer overlay spec).
          message: /\bnullfont\b/.test(line)
            ? composeMessage(
              line.trim(),
              "",
              "text typeset where no font is active — look for a stray character in a length argument, tabular column spec, TikZ picture or overlay spec near this point (e.g. a unit without a number, or text between columns/rows)",
            )
            : line.trim(),
          path: here.path,
          line: null,
          causeToken: glyph[1] ?? "",
          rawLogRange: { startLine: lineNo, endLine: lineNo },
          confidence: "heuristic",
        }),
      );
      continue;
    }

    // ---- plain structure line: file stack + shipped pages --------------
    scanLine(line, st, resolver);
  }

  return { diagnostics, noOutputWritten, outputWrittenPath, pageCount };
}

/**
 * Fallback for builds with no parseable .log (e.g. killed early): surface
 * tectonic's stderr "error: ..." lines as low-confidence diagnostics.
 */
export function parseRunnerStderr(stderrText: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stderrText.split("\n");
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = (lines[idx] as string).trim();
    const m = /^error:\s*(.+)$/i.exec(line);
    if (m !== null) {
      diagnostics.push(
        makeDiagnostic({
          code: "RUNNER_ERROR",
          severity: "error",
          message: m[1] ?? line,
          path: null,
          line: null,
          causeToken: line,
          rawLogRange: { startLine: idx + 1, endLine: idx + 1 },
          confidence: "unknown",
        }),
      );
    }
    if (/using only cached resource files/i.test(line)) {
      continue;
    }
  }
  return diagnostics;
}

/** Strip ANSI/terminal control sequences before external display. */
export function sanitizeLogForDisplay(text: string): string {
  // CSI sequences, OSC, and stray control chars other than tab/newline.
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
