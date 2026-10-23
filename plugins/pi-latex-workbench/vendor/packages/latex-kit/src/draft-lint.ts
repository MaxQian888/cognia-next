/**
 * Draft lint (ruleset "draft"): fast, deterministic SOURCE checks for
 * ordinary writing, in the spirit of chktex/lacheck/textidote. Pure: the
 * input is a map of project-relative path → UTF-8 text (snapshot files), no
 * filesystem or build access. Every source scan works on a comment-masked
 * view that preserves string length (offsets and line numbers stay exact),
 * so commented-out text never produces a finding. Findings read
 * "path:line …", are sorted by (path, offset) and capped.
 *
 * The workbench runner (`runDraftChecks` in @latexwb/core) adds the
 * build-log check, digests, scope and timestamps around this result.
 */
import { parseBibTeX } from "./bib.ts";
import { posixDirname, posixNormalize } from "./posix-path.ts";
import type { DraftCheckSeverity, DraftCheckStatus } from "./types.ts";
import { utf8Bytes } from "./utf8.ts";

/** One source-lint outcome (the runner adds digest/scope/timestamps). */
export interface DraftLintResult {
  checkId: string;
  status: DraftCheckStatus;
  severity: DraftCheckSeverity;
  findings: string[];
  /** Snapshot paths the findings point at (sorted, unique). */
  paths: string[];
}

/** Max findings listed per check; the remainder is summarized "… N more". */
export const DRAFT_FINDING_CAP = 40;

/** Filler for masked comments. Deliberately NOT whitespace: in
 * `Figure%⏎\ref` TeX sees no space, and neither should the lint. */
const COMMENT_FILL = "\u0001";
/** Filler for opaque regions (math, verbatim, URLs, keys…) in the prose
 * view — not whitespace and not a letter, so it breaks word adjacency. */
const OPAQUE_FILL = "\u0002";

const DRAFT_VERBATIM_ENVS: ReadonlySet<string> = new Set([
  "verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim",
  "lstlisting", "minted", "filecontents", "filecontents*", "comment",
]);

interface MaskedTex {
  /** Comments (and `comment` environments) replaced by COMMENT_FILL; line
   * breaks kept; same length as the input. */
  masked: string;
  /** [start, end) of verbatim-like environments and inline \verb. */
  verbatim: Array<[number, number]>;
  /** Files written by filecontents environments (e.g. an inline .bib). */
  filecontents: Array<{ name: string; body: string }>;
}

/**
 * Length-preserving comment masking: an unescaped `%` blanks to end of line
 * (`\%` is a literal percent; `\\%` is a line break followed by a comment —
 * escapes are consumed pairwise). Verbatim/lstlisting/minted/filecontents
 * bodies and inline \verb are left untouched (a `%` there is literal) and
 * reported as ranges; `comment` environments are blanked like comments.
 */
function maskTexComments(src: string): MaskedTex {
  const out = src.split("");
  const verbatim: Array<[number, number]> = [];
  const filecontents: Array<{ name: string; body: string }> = [];
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      const c = out[k];
      if (c !== "\n" && c !== "\r") out[k] = COMMENT_FILL;
    }
  };
  let i = 0;
  while (i < n) {
    const ch = src.charCodeAt(i);
    if (ch === 92 /* backslash */) {
      if (src.startsWith("\\begin", i)) {
        const m = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(src.slice(i, i + 64));
        if (m !== null && DRAFT_VERBATIM_ENVS.has(m[1] as string)) {
          const env = m[1] as string;
          const endNeedle = `\\end{${env}}`;
          const bodyStart = i + m[0].length;
          const endIdx = src.indexOf(endNeedle, bodyStart);
          const stop = endIdx === -1 ? n : endIdx + endNeedle.length;
          if (env === "comment") {
            blank(i, stop);
          } else {
            verbatim.push([i, stop]);
            if (env.startsWith("filecontents")) {
              const fm = /^\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/.exec(src.slice(bodyStart, bodyStart + 512));
              if (fm !== null) {
                filecontents.push({
                  name: (fm[1] as string).trim(),
                  body: src.slice(bodyStart + fm[0].length, endIdx === -1 ? n : endIdx),
                });
              }
            }
          }
          i = stop;
          continue;
        }
      }
      const vm = /^\\verb\*?([^A-Za-z*\s])/.exec(src.slice(i, i + 8));
      if (vm !== null) {
        const delim = vm[1] as string;
        const bodyStart = i + vm[0].length;
        const eol = src.indexOf("\n", bodyStart);
        const lineEnd = eol === -1 ? n : eol;
        const close = src.indexOf(delim, bodyStart);
        const stop = close === -1 || close >= lineEnd ? lineEnd : close + 1;
        verbatim.push([i, stop]);
        i = stop;
        continue;
      }
      i += 2; // an escape pair: \%, \\, \{, \$ …
      continue;
    }
    if (ch === 37 /* % */) {
      const eol = src.indexOf("\n", i);
      const stop = eol === -1 ? n : eol;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return { masked: out.join(""), verbatim, filecontents };
}

function blankRanges(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  fill: string,
): string {
  if (ranges.length === 0) return text;
  const out = text.split("");
  for (const [a, b] of ranges) {
    for (let k = Math.max(0, a); k < b && k < out.length; k += 1) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = fill;
    }
  }
  return out.join("");
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let k = 0; k < text.length; k += 1) {
    if (text.charCodeAt(k) === 10) starts.push(k + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Code-unit string comparison (locale-independent, deterministic). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cap a findings list at `cap` entries, summarizing the rest as "… N more". */
export function capFindings(items: readonly string[], cap = DRAFT_FINDING_CAP): string[] {
  if (items.length <= cap) return [...items];
  return [...items.slice(0, cap), `… ${items.length - cap} more`];
}

/** Index just past the group opened at t[i] (`{`, `[` or `(`), or -1.
 * Escapes are skipped; bracket/paren groups ignore content inside braces
 * and never span a blank line; scanning stops after `limit` chars. */
function groupEnd(t: string, i: number, limit = 4000): number {
  const open = t[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  const stop = Math.min(t.length, i + limit);
  let depth = 0;
  let braces = 0;
  for (let k = i; k < stop; k += 1) {
    const c = t[k];
    if (c === "\\") {
      k += 1;
      continue;
    }
    if (open !== "{") {
      if (c === "\n" && /^\n[ \t\r\u0001]*\n/.test(t.slice(k, k + 64))) return -1;
      if (c === "{") {
        braces += 1;
        continue;
      }
      if (c === "}") {
        braces -= 1;
        continue;
      }
      if (braces > 0) continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

interface ArgSpec {
  /** Optional `[..]` arguments accepted. */
  opt: number;
  /** Mandatory `{..}` groups. */
  groups: number;
  /** biblatex multicite: `(pre)(post)[..][..]{k}[..]{k}…` repeated. */
  multi?: boolean;
  /** \verb-style delimited argument (`\url|…|`, `\lstinline!…!`). */
  delim?: boolean;
}

interface ParsedArgs {
  /** Whole `[..]`/`(..)` ranges. */
  opts: Array<[number, number]>;
  /** Group CONTENT ranges (inside the braces/delimiters). */
  groups: Array<[number, number]>;
  end: number;
}

function parseArgs(t: string, from: number, spec: ArgSpec): ParsedArgs {
  const opts: Array<[number, number]> = [];
  const groups: Array<[number, number]> = [];
  let i = from;
  let optsSeen = 0;
  for (;;) {
    let j = i;
    let newlines = 0;
    while (j < t.length) {
      const c = t[j];
      if (c === " " || c === "\t" || c === "\r" || c === COMMENT_FILL) {
        j += 1;
        continue;
      }
      if (c === "\n" && newlines === 0) {
        newlines += 1;
        j += 1;
        continue;
      }
      break;
    }
    const c = t[j];
    if (c === "(" && spec.multi === true) {
      const e = groupEnd(t, j);
      if (e === -1) break;
      opts.push([j, e]);
      i = e;
      continue;
    }
    if (c === "[" && (spec.multi === true || optsSeen < spec.opt)) {
      const e = groupEnd(t, j);
      if (e === -1) break;
      opts.push([j, e]);
      optsSeen += 1;
      i = e;
      continue;
    }
    if (c === "{" && (spec.multi === true || groups.length < spec.groups)) {
      const e = groupEnd(t, j);
      if (e === -1) break;
      groups.push([j + 1, e - 1]);
      i = e;
      if (spec.multi !== true && groups.length >= spec.groups) break;
      continue;
    }
    if (
      spec.delim === true &&
      j === i &&
      groups.length < spec.groups &&
      c !== undefined &&
      /[^A-Za-z0-9\s{}[\]\\\u0001\u0002]/.test(c)
    ) {
      const close = t.indexOf(c, j + 1);
      const eol = t.indexOf("\n", j + 1);
      if (close === -1 || (eol !== -1 && close > eol)) break;
      groups.push([j + 1, close]);
      i = close + 1;
    }
    break;
  }
  return { opts, groups, end: i };
}

// ---- command vocabularies ----------------------------------------------------

const CITE_COMMANDS = [
  "cite", "Cite", "citet", "Citet", "citep", "Citep", "citealt", "Citealt",
  "citealp", "Citealp", "citeauthor", "Citeauthor", "citeyear", "citeyearpar",
  "citenum", "citetitle", "citeurl", "citedate", "parencite", "Parencite",
  "textcite", "Textcite", "autocite", "Autocite", "footcite", "footcitetext",
  "smartcite", "Smartcite", "supercite", "fullcite", "footfullcite", "nocite",
  "citepos",
];
const MULTI_CITE_COMMANDS = [
  "cites", "Cites", "parencites", "Parencites", "textcites", "Textcites",
  "autocites", "Autocites", "footcites", "smartcites", "Smartcites", "supercites",
];
const REF_COMMANDS = [
  "ref", "eqref", "pageref", "autoref", "autopageref", "nameref", "vref", "Vref",
  "vpageref", "cref", "Cref", "cpageref", "Cpageref", "labelcref", "namecref",
  "nameCref", "lcnamecref", "subref", "fullref",
];
const REF_RANGE_COMMANDS = ["crefrange", "Crefrange", "cpagerefrange", "Cpagerefrange", "vrefrange"];
/** Ref commands whose argument may be a comma-separated key list. */
const REF_LIST_COMMANDS: ReadonlySet<string> = new Set([
  "cref", "Cref", "cpageref", "Cpageref", "labelcref", "vref", "Vref",
]);

function commandRe(names: readonly string[]): RegExp {
  return new RegExp(`\\\\(${names.join("|")})(?![A-Za-z@])\\*?`, "g");
}

const DRAFT_CITE_RE = commandRe([...CITE_COMMANDS, ...MULTI_CITE_COMMANDS]);
const DRAFT_REF_RE = commandRe([...REF_COMMANDS, ...REF_RANGE_COMMANDS]);
const DRAFT_LABEL_RE = /\\label\s*(?:\[[^\]\n]*\])?\s*\{([^{}]*)\}/g;
/** `label=key` inside the options of \begin{lstlisting}[…], tcolorbox,
 * thmtools theorems, \lstinputlisting[…] — resolution only. */
const DRAFT_OPTION_LABEL_RE =
  /\\(?:begin\s*\{[A-Za-z*]+\}|lstinputlisting|inputminted)\s*(?:\{[^{}]*\}\s*)?\[([^\]]*)\]/g;
const DRAFT_BIBITEM_RE = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;

/** Arguments that are never prose (URLs, keys, paths, code, units…). */
const PROSE_OPAQUE_ARGS: Record<string, ArgSpec> = {
  url: { opt: 0, groups: 1, delim: true },
  nolinkurl: { opt: 0, groups: 1 },
  path: { opt: 0, groups: 1, delim: true },
  href: { opt: 1, groups: 1 },
  hyperref: { opt: 1, groups: 0 },
  label: { opt: 1, groups: 1 },
  input: { opt: 0, groups: 1 },
  include: { opt: 0, groups: 1 },
  subfile: { opt: 0, groups: 1 },
  import: { opt: 0, groups: 2 },
  subimport: { opt: 0, groups: 2 },
  includegraphics: { opt: 2, groups: 1 },
  includepdf: { opt: 1, groups: 1 },
  usepackage: { opt: 1, groups: 1 },
  RequirePackage: { opt: 1, groups: 1 },
  documentclass: { opt: 1, groups: 1 },
  bibliography: { opt: 0, groups: 1 },
  bibliographystyle: { opt: 0, groups: 1 },
  addbibresource: { opt: 1, groups: 1 },
  bibitem: { opt: 1, groups: 1 },
  begin: { opt: 0, groups: 1 },
  end: { opt: 0, groups: 1 },
  texttt: { opt: 0, groups: 1 },
  lstinline: { opt: 1, groups: 1, delim: true },
  mintinline: { opt: 1, groups: 2, delim: true },
  ensuremath: { opt: 0, groups: 1 },
  SI: { opt: 1, groups: 2 },
  si: { opt: 1, groups: 1 },
  num: { opt: 1, groups: 1 },
  qty: { opt: 1, groups: 2 },
  unit: { opt: 1, groups: 1 },
  ang: { opt: 1, groups: 1 },
  color: { opt: 1, groups: 1 },
  textcolor: { opt: 1, groups: 1 },
  setlength: { opt: 0, groups: 2 },
  vspace: { opt: 0, groups: 1 },
  hspace: { opt: 0, groups: 1 },
  newcommand: { opt: 2, groups: 2 },
  renewcommand: { opt: 2, groups: 2 },
  providecommand: { opt: 2, groups: 2 },
  pagestyle: { opt: 0, groups: 1 },
  thispagestyle: { opt: 0, groups: 1 },
  pagenumbering: { opt: 0, groups: 1 },
  hypersetup: { opt: 0, groups: 1 },
  graphicspath: { opt: 0, groups: 1 },
  ...Object.fromEntries(CITE_COMMANDS.map((c) => [c, { opt: 2, groups: 1 }])),
  ...Object.fromEntries(MULTI_CITE_COMMANDS.map((c) => [c, { opt: 2, groups: 1, multi: true }])),
  ...Object.fromEntries(REF_COMMANDS.map((c) => [c, { opt: 0, groups: 1 }])),
  ...Object.fromEntries(REF_RANGE_COMMANDS.map((c) => [c, { opt: 0, groups: 2 }])),
};
const PROSE_OPAQUE_RE = commandRe(Object.keys(PROSE_OPAQUE_ARGS));

const DRAFT_MATH_ENVS = [
  "equation", "align", "alignat", "gather", "multline", "flalign", "eqnarray",
  "math", "displaymath", "dmath", "dgroup", "darray", "IEEEeqnarray",
  "IEEEeqnarraybox",
];
/** Code-like environments whose content is not prose (TikZ keys, pgfplots
 * `\foreach … {1,...,5}`, pseudo-code). */
const DRAFT_OPAQUE_ENVS = [
  "tikzpicture", "pgfpicture", "tikzcd", "circuitikz", "forest", "axis",
  "semilogxaxis", "semilogyaxis", "loglogaxis", "polaraxis", "groupplot",
  "algorithmic", "algorithm2e",
];
const DRAFT_OPAQUE_ENV_RE = new RegExp(
  `\\\\begin\\s*\\{(${[...DRAFT_MATH_ENVS, ...DRAFT_OPAQUE_ENVS].join("|")})(\\*?)\\}`,
  "g",
);

/** `\[…\]`, `\(…\)`, `$$…$$` and `$…$` (unescaped; inline `$` never spans a
 * blank line). Input is already comment/verbatim-masked. */
function mathDelimiterRanges(t: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const n = t.length;
  const findClose = (needle: string, from: number, stopAtPar: boolean): number => {
    let k = from;
    while (k < n) {
      const c = t[k];
      if (c === "\\") {
        if (needle.startsWith("\\") && t.startsWith(needle, k)) return k;
        k += 2;
        continue;
      }
      if (stopAtPar && c === "\n" && /^\n[ \t\r\u0001]*\n/.test(t.slice(k, k + 64))) return -1;
      if (!needle.startsWith("\\") && t.startsWith(needle, k)) return k;
      k += 1;
    }
    return -1;
  };
  let i = 0;
  while (i < n) {
    const c = t[i];
    if (c === "\\") {
      const d = t[i + 1];
      if (d === "[" || d === "(") {
        const close = findClose(d === "[" ? "\\]" : "\\)", i + 2, false);
        if (close !== -1) {
          ranges.push([i, close + 2]);
          i = close + 2;
          continue;
        }
      }
      i += 2;
      continue;
    }
    if (c === "$") {
      if (t[i + 1] === "$") {
        const close = findClose("$$", i + 2, false);
        if (close !== -1) {
          ranges.push([i, close + 2]);
          i = close + 2;
          continue;
        }
        i += 2;
        continue;
      }
      const close = findClose("$", i + 1, true);
      if (close !== -1) {
        ranges.push([i, close + 1]);
        i = close + 1;
        continue;
      }
    }
    i += 1;
  }
  return ranges;
}

interface DraftSource {
  path: string;
  /** Comment-masked (COMMENT_FILL), verbatim intact. */
  masked: string;
  /** Comments AND verbatim blanked with spaces: labels, refs, citations,
   * floats and placeholders scan this. */
  lint: string;
  verbatim: Array<[number, number]>;
  filecontents: Array<{ name: string; body: string }>;
  lines: number[];
}

function draftSource(path: string, raw: string): DraftSource {
  const m = maskTexComments(raw);
  const lint = blankRanges(m.masked.replaceAll(COMMENT_FILL, " "), m.verbatim, " ");
  return {
    path,
    masked: m.masked,
    lint,
    verbatim: m.verbatim,
    filecontents: m.filecontents,
    lines: lineStartsOf(raw),
  };
}

/** [start, end) of the document body; whole file for included fragments. */
function documentBody(lint: string): [number, number] {
  const b = /\\begin\s*\{document\}/.exec(lint);
  const start = b === null ? 0 : b.index + b[0].length;
  const e = /\\end\s*\{document\}/.exec(lint.slice(start));
  return [start, e === null ? lint.length : start + e.index];
}

/**
 * The prose view for typography: comments → COMMENT_FILL; verbatim, the
 * preamble, math, code-like environments and non-prose command arguments
 * (URLs, keys, paths, \texttt, units…) → OPAQUE_FILL. Length-preserving.
 */
function proseView(src: DraftSource): string {
  let t = blankRanges(src.masked, src.verbatim, OPAQUE_FILL);
  const [bodyStart, bodyEnd] = documentBody(src.lint);
  t = blankRanges(t, [[0, bodyStart], [bodyEnd, t.length]], OPAQUE_FILL);
  const envRanges: Array<[number, number]> = [];
  const envRe = new RegExp(DRAFT_OPAQUE_ENV_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = envRe.exec(t)) !== null) {
    const needle = `\\end{${m[1] as string}${m[2] as string}}`;
    const endIdx = t.indexOf(needle, m.index + m[0].length);
    const stop = endIdx === -1 ? t.length : endIdx + needle.length;
    envRanges.push([m.index, stop]);
    envRe.lastIndex = stop;
  }
  t = blankRanges(t, envRanges, OPAQUE_FILL);
  const argRanges: Array<[number, number]> = [];
  const argRe = new RegExp(PROSE_OPAQUE_RE.source, "g");
  while ((m = argRe.exec(t)) !== null) {
    const spec = PROSE_OPAQUE_ARGS[m[1] as string] as ArgSpec;
    const parsed = parseArgs(t, m.index + m[0].length, spec);
    for (const r of parsed.opts) argRanges.push(r);
    for (const [a, b] of parsed.groups) argRanges.push([a - 1, b + 1]);
    if (parsed.end > argRe.lastIndex) argRe.lastIndex = parsed.end;
  }
  t = blankRanges(t, argRanges, OPAQUE_FILL);
  return blankRanges(t, mathDelimiterRanges(t), OPAQUE_FILL);
}

function usableKey(key: string): boolean {
  return key.length > 0 && !/[#\\]/.test(key);
}

/**
 * One-argument user macros whose body applies a command from `family` to
 * `#1` — `\newcommand{\figref}[1]{Figure~\ref{#1}}`, `\def\mycite#1{\cite{#1}}`
 * — so `\figref{fig:x}` counts as a reference (or citation) of `fig:x`.
 */
function wrapperMacros(sources: Iterable<DraftSource>, family: readonly string[]): Set<string> {
  const names = new Set<string>();
  const use = new RegExp(`\\\\(?:${family.join("|")})(?![A-Za-z@])\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{\\s*#1\\s*\\}`);
  const defs = [
    /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\[\s*1\s*\]\s*(?=\{)/g,
    /\\def\s*\\([A-Za-z@]+)\s*#1\s*(?=\{)/g,
  ];
  for (const src of sources) {
    for (const re of defs) {
      for (const m of src.lint.matchAll(re)) {
        const open = m.index + m[0].length;
        const end = groupEnd(src.lint, open);
        if (end !== -1 && use.test(src.lint.slice(open, end))) names.add(m[1] as string);
      }
    }
  }
  for (const builtin of family) names.delete(builtin);
  return names;
}

function relJoin(dir: string, name: string): string | null {
  const p = posixNormalize(dir === "" ? name : `${dir}/${name}`).replace(/^\.\//, "");
  if (p === ".." || p.startsWith("../") || p.startsWith("/")) return null;
  return p;
}

function dirOf(path: string): string {
  const d = posixDirname(path);
  return d === "." ? "" : d;
}

/**
 * Files the draft checks scan: everything reachable from the target root via
 * \input/\include/\subfile/\import (so stale, un-included drafts stay
 * quiet). Falls back to every .tex file when there is no known root or an
 * include target is macro-computed (the graph cannot be trusted then).
 */
function draftScanSet(
  sources: ReadonlyMap<string, DraftSource>,
  root: string | null,
): { paths: string[]; note: string } {
  const all = [...sources.keys()].sort(cmpStr);
  if (root === null || !sources.has(root)) {
    return { paths: all, note: `${all.length} .tex file(s) (no resolvable target root)` };
  }
  const rootDir = dirOf(root);
  const resolveTex = (target: string, bases: readonly string[]): string | null => {
    const t = target.trim().replace(/^"(.*)"$/, "$1");
    const names = /\.[A-Za-z0-9]+$/.test(t) ? [t] : [`${t}.tex`, t];
    for (const base of bases) {
      for (const name of names) {
        const p = relJoin(base, name);
        if (p !== null && sources.has(p)) return p;
      }
    }
    return null;
  };
  const seen = new Set<string>([root]);
  const queue = [root];
  let dynamic = false;
  const visit = (target: string, bases: string[]): void => {
    if (/[\\#]/.test(target)) {
      dynamic = true;
      return;
    }
    const found = resolveTex(target, [...new Set(bases)]);
    if (found !== null && !seen.has(found)) {
      seen.add(found);
      queue.push(found);
    }
  };
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const text = (sources.get(path) as DraftSource).lint;
    const fileDir = dirOf(path);
    for (const m of text.matchAll(/\\(?:input|include|subfile|InputIfFileExists)\s*\{([^{}]*)\}/g)) {
      visit(m[1] as string, ["", rootDir, fileDir]);
    }
    for (const m of text.matchAll(/\\input\s+([^\s{}\\%]+)/g)) {
      visit(m[1] as string, ["", rootDir, fileDir]);
    }
    for (const m of text.matchAll(
      /\\(sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    )) {
      const dir = (m[2] as string).trim().replace(/\/+$/, "");
      const base = relJoin(m[1] === "sub" ? fileDir : rootDir, dir === "" ? "." : dir) ?? "";
      visit(m[3] as string, [base === "." ? "" : base]);
    }
  }
  if (dynamic) {
    return { paths: all, note: `${all.length} .tex file(s) (include graph has macro-computed targets)` };
  }
  return { paths: [...seen].sort(cmpStr), note: `${seen.size} file(s) reachable from ${root}` };
}

interface Located {
  path: string;
  at: number;
  text: string;
}

function sortLocated<T extends Located>(items: T[]): T[] {
  return items.sort((a, b) => cmpStr(a.path, b.path) || a.at - b.at || cmpStr(a.text, b.text));
}

export interface DraftLint {
  /** The source checks in ruleset order (everything but draft.build-log). */
  results: DraftLintResult[];
  /** .tex files the checks scanned (reachable from the root), sorted. */
  scannedPaths: string[];
  /** Every .tex file offered. */
  texFileCount: number;
}

/**
 * Pure source lint over snapshot text files (path → UTF-8 text; .tex, .bib
 * and .bbl are used). `root` is the target's root document (null = detect a
 * single \documentclass file, else scan every .tex file).
 */
export function lintDraftSources(
  files: ReadonlyMap<string, string>,
  root: string | null,
): DraftLint {
  const sources = new Map<string, DraftSource>();
  for (const [path, text] of [...files].sort((a, b) => cmpStr(a[0], b[0]))) {
    if (/\.tex$/i.test(path)) sources.set(path, draftSource(path, text));
  }
  let rootPath = root;
  if (rootPath === null || !sources.has(rootPath)) {
    const withClass = [...sources.values()].filter((s) =>
      /\\documentclass\b/.test(s.lint) && /\\begin\s*\{document\}/.test(s.lint));
    rootPath = withClass.length === 1 ? (withClass[0] as DraftSource).path : null;
  }
  const scan = draftScanSet(sources, rootPath);
  const scanned = scan.paths.map((p) => sources.get(p) as DraftSource);
  const lineOf = (src: DraftSource, at: number): number => lineAt(src.lines, at);
  const loc = (src: DraftSource, at: number): string => `${src.path}:${lineOf(src, at)}`;
  const pathsOf = (items: Located[]): string[] => [...new Set(items.map((i) => i.path))].sort(cmpStr);
  const results: DraftLintResult[] = [];
  const emit = (
    checkId: string,
    status: DraftCheckStatus,
    severity: DraftCheckSeverity,
    findings: string[],
    located: Located[] = [],
  ): void => {
    results.push({ checkId, status, severity, findings, paths: pathsOf(located) });
  };

  // ---- labels + references ----------------------------------------------
  const knownLabels = new Set<string>();
  const labelDefs = new Map<string, Array<{ src: DraftSource; at: number }>>();
  const scannedSet = new Set(scan.paths);
  for (const src of sources.values()) {
    for (const m of src.lint.matchAll(DRAFT_LABEL_RE)) {
      const key = (m[1] as string).trim();
      if (!usableKey(key)) continue;
      knownLabels.add(key);
      if (scannedSet.has(src.path)) {
        const defs = labelDefs.get(key) ?? [];
        defs.push({ src, at: m.index });
        labelDefs.set(key, defs);
      }
    }
    for (const m of src.masked.matchAll(DRAFT_OPTION_LABEL_RE)) {
      const lm = /(?:^|[,\s])label\s*=\s*\{?([^,{}\]\s]+)/.exec(m[1] as string);
      if (lm !== null) knownLabels.add((lm[1] as string).trim());
    }
  }
  const refUses: Array<{ key: string; cmd: string; src: DraftSource; at: number }> = [];
  const refWrappers = wrapperMacros(sources.values(), [...REF_COMMANDS, ...REF_RANGE_COMMANDS]);
  const externalDocs = scanned.some((s) => /\\external(?:cite)?document\b/.test(s.lint));
  for (const src of scanned) {
    for (const m of src.lint.matchAll(DRAFT_REF_RE)) {
      const cmd = m[1] as string;
      const isRange = REF_RANGE_COMMANDS.includes(cmd);
      const parsed = parseArgs(src.lint, m.index + m[0].length, { opt: 0, groups: isRange ? 2 : 1 });
      for (const [a, b] of parsed.groups) {
        const raw = src.lint.slice(a, b);
        const keys = REF_LIST_COMMANDS.has(cmd) ? raw.split(",") : [raw];
        for (const k of keys) {
          const key = k.trim();
          if (usableKey(key)) refUses.push({ key, cmd, src, at: m.index });
        }
      }
    }
    for (const m of src.lint.matchAll(/\\hyperref\s*\[([^\]]*)\]/g)) {
      const key = (m[1] as string).trim();
      if (usableKey(key)) refUses.push({ key, cmd: "hyperref", src, at: m.index });
    }
    if (refWrappers.size > 0) {
      for (const m of src.lint.matchAll(commandRe([...refWrappers]))) {
        const parsed = parseArgs(src.lint, m.index + m[0].length, { opt: 0, groups: 1 });
        for (const [a, b] of parsed.groups) {
          for (const k of src.lint.slice(a, b).split(",")) {
            const key = k.trim();
            if (usableKey(key)) refUses.push({ key, cmd: m[1] as string, src, at: m.index });
          }
        }
      }
    }
  }
  const referenced = new Set(refUses.map((r) => r.key));
  {
    const missing = sortLocated(
      refUses
        .filter((r) => !knownLabels.has(r.key))
        .map((r) => ({
          path: r.src.path,
          at: r.at,
          text: r.cmd === "hyperref"
            ? `${loc(r.src, r.at)} \\hyperref[${r.key}] has no matching \\label`
            : `${loc(r.src, r.at)} \\${r.cmd}{${r.key}} has no matching \\label`,
        })),
    );
    if (refUses.length === 0) {
      emit("draft.references", "not-applicable", "info", [
        `no \\ref-family cross-references in ${scan.note}`,
      ]);
    } else if (missing.length === 0) {
      emit("draft.references", "pass", "info", [
        `all ${refUses.length} cross-reference(s) resolve to a \\label (${knownLabels.size} label(s) defined; scanned ${scan.note})`,
      ]);
    } else {
      emit(
        "draft.references",
        externalDocs ? "needs-review" : "fail",
        "warning",
        [
          ...(externalDocs
            ? ["the project loads xr \\externaldocument — keys below may resolve in the external document"]
            : []),
          ...capFindings(missing.map((x) => x.text)),
        ],
        missing,
      );
    }
  }

  // ---- duplicate labels --------------------------------------------------
  {
    const dups = [...labelDefs.entries()]
      .filter(([, defs]) => defs.length > 1)
      .sort((a, b) => cmpStr(a[0], b[0]));
    const located: Located[] = dups.flatMap(([, defs]) =>
      defs.map((d) => ({ path: d.src.path, at: d.at, text: "" })));
    if (labelDefs.size === 0) {
      emit("draft.duplicate-labels", "not-applicable", "info", [`no \\label definitions in ${scan.note}`]);
    } else if (dups.length === 0) {
      emit("draft.duplicate-labels", "pass", "info", [
        `${labelDefs.size} label(s), each defined exactly once`,
      ]);
    } else {
      emit(
        "draft.duplicate-labels",
        "fail",
        "error",
        capFindings(
          dups.map(([key, defs]) =>
            `label "${key}" defined ${defs.length}× — ${defs.map((d) => loc(d.src, d.at)).join(", ")}`),
        ),
        located,
      );
    }
  }

  // ---- citations + bibliography --------------------------------------------
  {
    const citeUses: Array<{ key: string; src: DraftSource; at: number }> = [];
    let nociteAll = false;
    const citeWrappers = wrapperMacros(sources.values(), [...CITE_COMMANDS, ...MULTI_CITE_COMMANDS]);
    for (const src of scanned) {
      if (citeWrappers.size > 0) {
        for (const m of src.lint.matchAll(commandRe([...citeWrappers]))) {
          const parsed = parseArgs(src.lint, m.index + m[0].length, { opt: 2, groups: 1 });
          for (const [a, b] of parsed.groups) {
            for (const k of src.lint.slice(a, b).split(",")) {
              const key = k.trim();
              if (usableKey(key)) citeUses.push({ key, src, at: m.index });
            }
          }
        }
      }
      for (const m of src.lint.matchAll(DRAFT_CITE_RE)) {
        const cmd = m[1] as string;
        const parsed = parseArgs(src.lint, m.index + m[0].length, {
          opt: 2,
          groups: 1,
          multi: MULTI_CITE_COMMANDS.includes(cmd),
        });
        for (const [a, b] of parsed.groups) {
          for (const k of src.lint.slice(a, b).split(",")) {
            const key = k.trim();
            if (key === "*" && cmd === "nocite") nociteAll = true;
            else if (usableKey(key)) citeUses.push({ key, src, at: m.index });
          }
        }
      }
    }
    // Source order, so "first use" below really is the earliest one.
    citeUses.sort((a, b) => cmpStr(a.src.path, b.src.path) || a.at - b.at);
    // Declared databases, resolved against the snapshot (and filecontents).
    const bibFiles = new Map<string, string>();
    for (const [path, text] of files) {
      if (/\.bib$/i.test(path)) bibFiles.set(path, text);
    }
    const virtualBibs = new Map<string, string>();
    for (const src of sources.values()) {
      for (const fc of src.filecontents) virtualBibs.set(fc.name.replace(/^\.\//, ""), fc.body);
    }
    const rootDir = rootPath === null ? "" : dirOf(rootPath);
    const resolveBib = (name: string, fromPath: string): string | null => {
      const base = name.trim();
      const names = /\.bib$/i.test(base) ? [base] : [`${base}.bib`, base];
      for (const dir of [...new Set(["", rootDir, dirOf(fromPath)])]) {
        for (const nm of names) {
          const p = relJoin(dir, nm);
          if (p !== null && bibFiles.has(p)) return p;
        }
      }
      for (const nm of names) if (virtualBibs.has(nm)) return nm;
      return null;
    };
    const databases = new Map<string, string>(); // resolved path → text
    const unresolved: Located[] = [];
    let declaredDatabases = 0;
    for (const src of scanned) {
      const decls: Array<{ name: string; at: number; cmd: string }> = [];
      for (const m of src.lint.matchAll(/\\bibliography\s*\{([^{}]*)\}/g)) {
        for (const nm of (m[1] as string).split(",")) {
          if (nm.trim() !== "") decls.push({ name: nm.trim(), at: m.index, cmd: "bibliography" });
        }
      }
      for (const m of src.lint.matchAll(
        /\\(addbibresource|addglobalbib|addsectionbib)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g,
      )) {
        if ((m[2] as string).trim() !== "") {
          decls.push({ name: (m[2] as string).trim(), at: m.index, cmd: m[1] as string });
        }
      }
      for (const d of decls) {
        declaredDatabases += 1;
        const p = resolveBib(d.name, src.path);
        if (p === null) {
          unresolved.push({
            path: src.path,
            at: d.at,
            text: `${loc(src, d.at)} \\${d.cmd}{${d.name}} — no such .bib file in the snapshot`,
          });
        } else {
          databases.set(p, bibFiles.get(p) ?? virtualBibs.get(p) ?? "");
        }
      }
    }
    const entries: Array<{ key: string; path: string; line: number }> = [];
    const parseErrors: string[] = [];
    for (const [path, text] of [...databases].sort((a, b) => cmpStr(a[0], b[0]))) {
      const parsed = parseBibTeX(utf8Bytes(text));
      for (const e of parsed.entries) entries.push({ key: e.key, path, line: e.line });
      for (const err of parsed.errors) parseErrors.push(`${path}:${err.line} bib parse error: ${err.message}`);
    }
    const bibitems: Array<{ key: string; src: DraftSource; at: number }> = [];
    for (const src of scanned) {
      for (const m of src.lint.matchAll(DRAFT_BIBITEM_RE)) {
        const key = (m[1] as string).trim();
        if (usableKey(key)) bibitems.push({ key, src, at: m.index });
      }
    }
    // A shipped .bbl (provided-bbl builds) only counts when a declared
    // database cannot be resolved or none is declared.
    const bblKeys = new Set<string>();
    if (unresolved.length > 0 || declaredDatabases === 0) {
      for (const [path, text] of files) {
        if (!/\.bbl$/i.test(path)) continue;
        for (const m of text.matchAll(DRAFT_BIBITEM_RE)) bblKeys.add((m[1] as string).trim());
        for (const m of text.matchAll(/\\entry\s*\{([^{}]+)\}/g)) bblKeys.add((m[1] as string).trim());
      }
    }
    const known = new Set<string>([
      ...entries.map((e) => e.key),
      ...bibitems.map((b) => b.key),
      ...bblKeys,
    ]);
    const knownLower = new Map<string, string>();
    for (const k of [...known].sort(cmpStr)) {
      if (!knownLower.has(k.toLowerCase())) knownLower.set(k.toLowerCase(), k);
    }
    const missingByKey = new Map<string, Array<{ src: DraftSource; at: number }>>();
    for (const u of citeUses) {
      if (known.has(u.key)) continue;
      const list = missingByKey.get(u.key) ?? [];
      list.push({ src: u.src, at: u.at });
      missingByKey.set(u.key, list);
    }
    const missing = sortLocated(
      [...missingByKey.entries()].map(([key, uses]) => {
        const first = uses[0] as { src: DraftSource; at: number };
        const ci = knownLower.get(key.toLowerCase());
        const hint = ci !== undefined ? ` (the bibliography has "${ci}" — keys are case-sensitive)` : "";
        const more = uses.length > 1 ? ` (+${uses.length - 1} more use(s))` : "";
        return {
          path: first.src.path,
          at: first.at,
          text: `${loc(first.src, first.at)} \\cite{${key}} — no bibliography entry${hint}${more}`,
        };
      }),
    );
    const noBibliography =
      declaredDatabases === 0 && bibitems.length === 0 && bblKeys.size === 0;
    const sourcesDesc = [
      ...[...databases.keys()].sort(cmpStr),
      ...(bibitems.length > 0 ? [`thebibliography (${bibitems.length} \\bibitem)`] : []),
      ...(bblKeys.size > 0 ? [`shipped .bbl (${bblKeys.size} entries)`] : []),
    ].join(", ");
    const unresolvedCounts = unresolved.length > 0 && bblKeys.size === 0;
    if (citeUses.length === 0 && !nociteAll) {
      // Macro definitions like \newcommand{\mycite}[1]{\cite{#1}} carry no
      // usable key and do not count as citing anything.
      emit("draft.citations", "not-applicable", "info", [`no citation keys in ${scan.note}`]);
    } else if (missing.length > 0 || unresolvedCounts) {
      emit(
        "draft.citations",
        "fail",
        "error",
        capFindings([
          ...(noBibliography
            ? [`${citeUses.length} citation(s) but no bibliography is declared (\\bibliography, \\addbibresource or thebibliography)`]
            : []),
          ...unresolved.map((u) => u.text),
          ...missing.map((x) => x.text),
          ...parseErrors,
        ]),
        [...unresolved, ...missing],
      );
    } else {
      const distinct = new Set(citeUses.map((u) => u.key)).size;
      emit("draft.citations", "pass", "info", capFindings([
        nociteAll && distinct === 0
          ? `\\nocite{*} includes every entry of ${sourcesDesc || "the bibliography"}`
          : `all ${distinct} cited key(s) resolve (${citeUses.length} use(s)) against ${sourcesDesc}`,
        ...unresolved.map((u) => `${u.text} (keys resolved from the shipped .bbl)`),
        ...parseErrors,
      ]));
    }

    // ---- unused bibliography entries (hygiene, informational) ------------
    const citedLower = new Set(citeUses.map((u) => u.key.toLowerCase()));
    const candidates = [
      ...entries.map((e) => ({
        path: e.path,
        at: e.line,
        text: `${e.path}:${e.line} entry "${e.key}" is never cited`,
        key: e.key,
      })),
      ...bibitems.map((b) => ({
        path: b.src.path,
        at: lineOf(b.src, b.at),
        text: `${loc(b.src, b.at)} \\bibitem{${b.key}} is never cited`,
        key: b.key,
      })),
    ].filter((c) => !citedLower.has(c.key.toLowerCase()));
    const totalEntries = entries.length + bibitems.length;
    if (totalEntries === 0) {
      emit("draft.unused-bib-entries", "not-applicable", "info", [
        "no bibliography database or thebibliography entries in use",
      ]);
    } else if (nociteAll) {
      emit("draft.unused-bib-entries", "not-applicable", "info", [
        "\\nocite{*} deliberately includes every bibliography entry",
      ]);
    } else if (candidates.length === 0) {
      emit("draft.unused-bib-entries", "pass", "info", [
        `all ${totalEntries} bibliography entr${totalEntries === 1 ? "y is" : "ies are"} cited`,
      ]);
    } else {
      const sorted = sortLocated(candidates);
      emit(
        "draft.unused-bib-entries",
        "fail",
        "info",
        capFindings(sorted.map((c) => c.text)),
        sorted,
      );
    }
  }

  // ---- floats ------------------------------------------------------------
  {
    const problems: Located[] = [];
    let floats = 0;
    for (const src of scanned) {
      for (const m of src.lint.matchAll(
        /\\begin\s*\{(figure|table|wrapfigure|wraptable|sidewaysfigure|sidewaystable|SCfigure|SCtable)(\*?)\}/g,
      )) {
        floats += 1;
        const env = `${m[1] as string}${m[2] as string}`;
        const bodyStart = m.index + m[0].length;
        const endIdx = src.lint.indexOf(`\\end{${env}}`, bodyStart);
        const body = src.lint.slice(bodyStart, endIdx === -1 ? src.lint.length : endIdx);
        const captions = [...body.matchAll(/\\caption(?:of)?(?![A-Za-z@])(\*?)/g)];
        const numbered = captions.some((c) => c[1] === "");
        const labels = [...body.matchAll(DRAFT_LABEL_RE)]
          .map((l) => (l[1] as string).trim())
          .filter(usableKey);
        const where = loc(src, m.index);
        if (captions.length === 0) {
          problems.push({
            path: src.path,
            at: m.index,
            text: labels.length > 0
              ? `${where} ${env} has no \\caption (its \\label{${labels[0] as string}} would reference the enclosing section)`
              : `${where} ${env} has no \\caption`,
          });
        } else if (numbered && labels.length === 0) {
          problems.push({ path: src.path, at: m.index, text: `${where} ${env} caption has no \\label (it cannot be referenced)` });
        } else if (labels.length > 0 && !labels.some((l) => referenced.has(l))) {
          problems.push({ path: src.path, at: m.index, text: `${where} ${env} "${labels[0] as string}" is never referenced` });
        }
      }
    }
    if (floats === 0) {
      emit("draft.floats", "not-applicable", "info", [`no figure/table floats in ${scan.note}`]);
    } else if (problems.length === 0) {
      emit("draft.floats", "pass", "info", [`${floats} float(s) captioned, labelled and referenced`]);
    } else {
      const sorted = sortLocated(problems);
      emit("draft.floats", "fail", "warning", capFindings(sorted.map((p) => p.text)), sorted);
    }
  }

  // ---- placeholders --------------------------------------------------------
  const prose = new Map(scanned.map((s) => [s.path, proseView(s)]));
  {
    const found: Located[] = [];
    const snippet = (src: DraftSource, at: number): string => {
      const line = lineOf(src, at);
      const start = src.lines[line - 1] as number;
      const end = src.lines[line] ?? src.lint.length + 1;
      const text = src.lint.slice(start, end - 1).replace(/\s+/g, " ").trim();
      return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    };
    const isDefinition = (text: string, at: number): boolean =>
      /\\(?:(?:new|renew|provide)command\*?|DeclareRobustCommand\*?|def|let)\s*\{?\s*$/.test(
        text.slice(Math.max(0, at - 40), at),
      );
    const rules: Array<{
      re: RegExp;
      what: (m: RegExpExecArray) => string;
      prose?: boolean;
      skipDefs?: boolean;
    }> = [
      { re: /\b(TODO|FIXME|XXX|TBD)s?(?![A-Za-z0-9])/g, what: (m) => `${m[1] as string} marker` },
      { re: /待补充|待完善/g, what: (m) => `"${m[0]}" marker` },
      { re: /\\(todo|missingfigure)(?![A-Za-z@])/g, what: (m) => `\\${m[1] as string} note`, skipDefs: true },
      {
        re: /\\(lipsum|blindtext|Blindtext)(?![A-Za-z@])/g,
        what: (m) => `\\${m[1] as string} filler text`,
        skipDefs: true,
      },
      { re: /lorem\s+ipsum/gi, what: () => "lorem ipsum filler text" },
      { re: /\?\?/g, what: () => "'??' in text", prose: true },
      {
        re: /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{\s*\}/g,
        what: (m) => `empty \\${m[1] as string}{} heading`,
      },
      { re: /\\begin\s*\{abstract\}\s*\\end\s*\{abstract\}/g, what: () => "empty abstract environment" },
    ];
    for (const src of scanned) {
      for (const rule of rules) {
        const text = rule.prose === true ? (prose.get(src.path) as string) : src.lint;
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (rule.skipDefs === true && isDefinition(text, m.index)) continue;
          found.push({
            path: src.path,
            at: m.index,
            text: `${loc(src, m.index)} ${rule.what(m)}: "${snippet(src, m.index)}"`,
          });
        }
      }
    }
    if (found.length === 0) {
      emit("draft.placeholders", "pass", "info", [
        `no TODO/FIXME/XXX markers, \\todo notes, filler text, '??', empty headings or empty abstract in ${scan.note} (comments are ignored)`,
      ]);
    } else {
      const sorted = sortLocated(found);
      emit("draft.placeholders", "fail", "warning", capFindings(sorted.map((f) => f.text)), sorted);
    }
  }

  // ---- typography (heuristic, informational) -------------------------------
  {
    const found: Located[] = [];
    const lastWord = (text: string, end: number): string => {
      const w = /(\S+)$/.exec(text.slice(Math.max(0, end - 24), end).replace(/[\u0001\u0002]/g, " "));
      return w === null ? "" : (w[1] as string);
    };
    const REPEAT_OK: ReadonlySet<string> = new Set(["that", "had"]);
    for (const src of scanned) {
      const t = prose.get(src.path) as string;
      const add = (at: number, text: string): void => {
        found.push({ path: src.path, at, text: `${loc(src, at)} ${text}` });
      };
      // Straight double quotes used as quotation marks: "word" (babel
      // shorthands like "` "' "- "= are excluded; CJK-adjacent quotes too).
      for (const m of t.matchAll(/(^|[\s(\[{~\u0001])"([^"\n\u0002]{1,120}?)"(?=$|[\s.,;:!?)\]}\u0001])/gm)) {
        const body = m[2] as string;
        if (/^[`'<>\-=|~\s]/.test(body) || /\s$/.test(body)) continue;
        const at = m.index + (m[1] as string).length;
        const shown = body.length > 30 ? `${body.slice(0, 27)}…` : body;
        add(at, `straight double quotes "${shown}" — use \`\`…'' or \\enquote{…}`);
      }
      for (const m of t.matchAll(/(?<![.\\])\.\.\.(?!\.)/g)) {
        add(m.index, `"..." — use \\dots`);
      }
      // A breakable space before \ref/\eqref/\pageref (Latin or 图/表/式
      // label words) or before a numeric \cite (Latin context only).
      for (const m of t.matchAll(
        /([A-Za-z0-9.,;:)\]}]|[图表式])(?:[ \t]+|[ \t]*\r?\n[ \t]*)\\(ref|eqref|pageref)(?![A-Za-z@])/g,
      )) {
        const at = m.index + (m[1] as string).length;
        const word = lastWord(t, at);
        const cmd = m[2] as string;
        add(at, `breakable space before \\${cmd} after "${word}" — use ${word}~\\${cmd}{…}`);
      }
      for (const m of t.matchAll(/([A-Za-z0-9.,;:)\]}])(?:[ \t]+|[ \t]*\r?\n[ \t]*)\\cite(?![A-Za-z@])/g)) {
        const at = m.index + (m[1] as string).length;
        add(at, `breakable space before \\cite after "${lastWord(t, at)}" — use ~\\cite{…}`);
      }
      // Immediately repeated Latin words ("the the"); CJK is never matched.
      for (const m of t.matchAll(
        /(?<![A-Za-z\\@])([A-Za-z]+)(?:[ \t]+\u0001*\r?\n?[ \t]*|\r?\n[ \t]*)(\1)(?![A-Za-z])/gi,
      )) {
        if (REPEAT_OK.has((m[1] as string).toLowerCase())) continue;
        add(m.index, `repeated word "${m[1] as string} ${m[2] as string}"`);
      }
    }
    if (found.length === 0) {
      emit("draft.typography", "pass", "info", [
        `no straight quotes, "..." ellipses, breakable spaces before \\ref/\\cite or repeated words in ${scan.note}`,
      ]);
    } else {
      const sorted = sortLocated(found);
      emit("draft.typography", "fail", "info", capFindings(sorted.map((f) => f.text)), sorted);
    }
  }

  return { results, scannedPaths: scan.paths, texFileCount: sources.size };
}

