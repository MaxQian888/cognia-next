/**
 * GitHub-style renderer for unified git patches. Parses `git diff` output into
 * sections/hunks, computes intra-line (word) diffs for paired deletions and
 * additions, and lays the result out as styled {@link TerminalLine}s — either
 * GitHub's default *unified* column or a *split* side-by-side view.
 *
 * Rendering contract mirrors GitHub: dual old/new line-number gutters, a sign
 * column carrying the add/del colour, syntax-highlighted code (whole-hunk
 * highlight so multi-line constructs colour correctly), emphasised changed
 * tokens, a section header with the file status, and hunk separator bars. When
 * the theme palette uses hex/rgb colours the changed rows also get a subtle
 * tinted background derived from the diff role colour; ANSI-name palettes fall
 * back to bold+underline emphasis (a background cannot be derived from a colour
 * keyword).
 *
 * Pure and Ink-free so the parse/layout is unit-tested without rendering.
 */
import { highlightCode, paletteCodeTheme } from "../markdown/highlight"
import { ansiToSpans } from "../render/ansi-spans"
import {
  terminalStringWidth,
  truncateTerminalSpans,
  wrapTerminalSpans,
  type TerminalLine,
  type TerminalSpan,
} from "../render/terminal-block"
import type { ThemePalette } from "../theme/palette"

export type PatchLayout = "unified" | "split"

/** One labelled patch body; the label becomes a chip on the section header. */
export interface PatchSectionInput {
  label?: string
  body: string
}

export interface PreparedPatch {
  lines: TerminalLine[]
  /** Indices into `lines` where hunk separator rows sit, for [/] navigation. */
  hunkRows: number[]
}

export interface PatchViewOptions {
  /** Terminal cells available to the patch pane (inside borders/padding). */
  width: number
  layout: PatchLayout
  /** highlight.js language id inferred from the file path. */
  lang?: string
  /** Active theme palette; undefined yields the classic ANSI look. */
  palette?: ThemePalette
  translate: (key: string, params?: Record<string, string | number>) => string
}

/** A changed-token range inside an add/del line. `hot` marks the edited part. */
export interface PatchSegment {
  text: string
  hot?: boolean
}

export interface PatchRow {
  kind: "add" | "del" | "context" | "meta"
  text: string
  oldNo?: number
  newNo?: number
  segments?: PatchSegment[]
}

export interface PatchHunk {
  /** The literal `@@ -a,b +c,d @@` range text. */
  header: string
  /** The trailing context (usually the enclosing function name). */
  context: string
  rows: PatchRow[]
}

export interface ParsedPatchSection {
  status: "modified" | "added" | "deleted" | "renamed" | "binary" | "mode"
  renameFrom?: string
  modeChange?: { from: string; to: string }
  /** Count of folded binary-patch payload lines (literal/delta bodies). */
  binaryPayloadLines: number
  /** Metadata lines worth surfacing verbatim when nothing else explains them. */
  metaLines: string[]
  hunks: PatchHunk[]
  /** Non-patch lines found inside the section, recorded at the position they
   * appeared (`afterHunks` = how many hunks preceded them) so they render in
   * place rather than being moved to the end of the file. */
  orphans: { line: string; afterHunks: number }[]
}

export interface ParsedPatchBody {
  /** Text before the first `diff --git` header (notes, malformed bodies). */
  preamble: string[]
  sections: ParsedPatchSection[]
}

const SECTION_RE = /^diff --(?:git|cc|combined) /
const HUNK_RE = /^(@{2,}) ((?:-\d+(?:,\d+)? )+\+\d+(?:,\d+)?) \1 ?(.*)$/

/** Tokenise for word diff: identifier-ish runs, whitespace, then punctuation. */
const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]+/gu

/** Above this token count per side the O(n·m) LCS is not worth it. */
const LCS_TOKEN_CAP = 64

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

function toSegments(tokens: string[], matched: boolean[]): PatchSegment[] {
  const out: PatchSegment[] = []
  tokens.forEach((token, index) => {
    const hot = !matched[index]
    const last = out[out.length - 1]
    if (last && Boolean(last.hot) === hot) last.text += token
    else out.push({ text: token, ...(hot ? { hot: true } : {}) })
  })
  return out
}

/**
 * Common-prefix/suffix fallback when a full token LCS would be too big. Marks
 * everything between the shared edges as changed — coarser, but bounded.
 */
function edgeSegments(a: string[], b: string[]): { matchedA: boolean[]; matchedB: boolean[] } {
  const matchedA = Array(a.length).fill(false)
  const matchedB = Array(b.length).fill(false)
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) {
    matchedA[lo] = matchedB[lo] = true
    lo++
  }
  let hi = 0
  while (
    hi < a.length - lo &&
    hi < b.length - lo &&
    a[a.length - 1 - hi] === b[b.length - 1 - hi]
  ) {
    matchedA[a.length - 1 - hi] = matchedB[b.length - 1 - hi] = true
    hi++
  }
  return { matchedA, matchedB }
}

/**
 * Token-level diff of one deleted line against one added line, GitHub's
 * intra-line highlight. Returns per-line segments with `hot` on the tokens that
 * actually changed; identical lines produce no hot segments at all.
 */
export function diffSegments(
  oldText: string,
  newText: string
): { old: PatchSegment[]; next: PatchSegment[] } {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  if (a.join("") === b.join("")) {
    return { old: [{ text: oldText }], next: [{ text: newText }] }
  }
  if (a.length > LCS_TOKEN_CAP || b.length > LCS_TOKEN_CAP) {
    const { matchedA, matchedB } = edgeSegments(a, b)
    return { old: toSegments(a, matchedA), next: toSegments(b, matchedB) }
  }
  // Classic LCS over tokens, then mark unmatched tokens as changed.
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = new Uint32Array(rows * cols)
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i * cols + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * cols + j - 1] + 1
          : Math.max(dp[(i - 1) * cols + j], dp[i * cols + j - 1])
    }
  }
  const matchedA = Array(a.length).fill(false)
  const matchedB = Array(b.length).fill(false)
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matchedA[i - 1] = matchedB[j - 1] = true
      i--
      j--
    } else if (dp[(i - 1) * cols + j] >= dp[i * cols + j - 1]) {
      i--
    } else {
      j--
    }
  }
  return { old: toSegments(a, matchedA), next: toSegments(b, matchedB) }
}

/** Walk a hunk's rows and pair each del-run with the add-run that follows it. */
function pairChangedRows(rows: PatchRow[]): void {
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++
      continue
    }
    let j = i
    while (rows[j]?.kind === "del") j++
    let k = j
    while (rows[k]?.kind === "add") k++
    const pairs = Math.min(j - i, k - j)
    for (let p = 0; p < pairs; p++) {
      const del = rows[i + p]
      const add = rows[j + p]
      const segments = diffSegments(del.text, add.text)
      del.segments = segments.old
      add.segments = segments.next
    }
    i = k
  }
}

/** Parse the `@@ -a,b +c,d @@`-family header into range counts. */
function parseHunkHeader(line: string): {
  header: string
  context: string
  columns: number
  oldCount: number
  newCount: number
  newStart: number
  oldStart: number
} | null {
  const match = HUNK_RE.exec(line)
  if (!match) return null
  const ranges = match[2].trim().split(" ")
  const minus = ranges.filter((r) => r.startsWith("-")).map((r) => r.slice(1).split(","))
  const plus = ranges
    .find((r) => r.startsWith("+"))
    ?.slice(1)
    .split(",")
  if (!minus.length || !plus) return null
  return {
    header: match[0].slice(0, match[0].length - (match[3] ? match[3].length + 1 : 0)).trimEnd(),
    context: match[3] ?? "",
    columns: match[1].length - 1,
    oldStart: Number(minus[0][0]),
    oldCount: Number(minus[0][1] ?? "1"),
    newStart: Number(plus[0]),
    newCount: Number(plus[1] ?? "1"),
  }
}

const META_RES: Array<{ re: RegExp; apply: (m: RegExpExecArray, s: ParsedPatchSection) => void }> =
  [
    {
      re: /^new file mode (\d+)/,
      apply: (_m, s) => {
        s.status = "added"
      },
    },
    {
      re: /^deleted file mode (\d+)/,
      apply: (_m, s) => {
        s.status = "deleted"
      },
    },
    {
      re: /^old mode (\d+)/,
      apply: (m, s) => {
        s.modeChange = { from: m[1], to: s.modeChange?.to ?? "" }
        if (s.status === "modified") s.status = "mode"
      },
    },
    {
      re: /^new mode (\d+)/,
      apply: (m, s) => {
        s.modeChange = { from: s.modeChange?.from ?? "", to: m[1] }
        if (s.status === "modified") s.status = "mode"
      },
    },
    {
      re: /^rename from (.+)/,
      apply: (m, s) => {
        s.status = "renamed"
        s.renameFrom = m[1]
      },
    },
    {
      re: /^rename to (.+)/,
      apply: (_m, s) => {
        if (s.status === "modified") s.status = "renamed"
      },
    },
    {
      re: /^(?:Binary files .* differ|GIT binary patch)$/,
      apply: (_m, s) => {
        s.status = "binary"
      },
    },
  ]

/**
 * Parse one patch body (a single scope's `git diff` output, possibly holding
 * several `diff --git` blocks) into sections, hunks and numbered rows. Anything
 * unrecognised is preserved verbatim as orphans — the renderer never drops
 * input it cannot explain.
 */
export function parsePatchBody(body: string): ParsedPatchBody {
  const lines = body.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  const parsed: ParsedPatchBody = { preamble: [], sections: [] }
  let section: ParsedPatchSection | null = null
  let hunk: PatchHunk | null = null
  let state: {
    columns: number
    oldLeft: number
    newLeft: number
    oldCursor: number
    newCursor: number
  } | null = null
  let inBinaryPayload = false

  const endHunk = () => {
    if (hunk) pairChangedRows(hunk.rows)
    hunk = null
    state = null
  }
  const pushOrphan = (line: string) => {
    if (section) section.orphans.push({ line, afterHunks: section.hunks.length })
    else parsed.preamble.push(line)
  }

  for (const line of lines) {
    if (SECTION_RE.test(line)) {
      endHunk()
      section = {
        status: "modified",
        binaryPayloadLines: 0,
        metaLines: [],
        hunks: [],
        orphans: [],
      }
      parsed.sections.push(section)
      inBinaryPayload = false
      continue
    }
    const hunkHeader = parseHunkHeader(line)
    if (hunkHeader && section) {
      endHunk()
      inBinaryPayload = false
      hunk = { header: hunkHeader.header, context: hunkHeader.context, rows: [] }
      section.hunks.push(hunk)
      state = {
        columns: hunkHeader.columns,
        oldLeft: hunkHeader.oldCount,
        newLeft: hunkHeader.newCount,
        oldCursor: hunkHeader.oldStart,
        newCursor: hunkHeader.newStart,
      }
      continue
    }
    if (hunk && state) {
      // `\ No newline at end of file` attaches to the previous row and does not
      // consume either range count.
      if (line.startsWith("\\")) {
        hunk.rows.push({ kind: "meta", text: line.slice(1).trimStart() || line })
        continue
      }
      if (state.oldLeft > 0 || state.newLeft > 0) {
        const prefix = line.slice(0, state.columns)
        if (prefix.length === state.columns && /^[ +-]+$/.test(prefix)) {
          const text = line.slice(state.columns)
          if (prefix.includes("+")) {
            hunk.rows.push({ kind: "add", text, newNo: state.newCursor++ })
            state.newLeft--
          } else if (prefix.includes("-")) {
            hunk.rows.push({ kind: "del", text, oldNo: state.oldCursor++ })
            state.oldLeft--
          } else {
            hunk.rows.push({
              kind: "context",
              text,
              oldNo: state.oldCursor++,
              newNo: state.newCursor++,
            })
            state.oldLeft--
            state.newLeft--
          }
          continue
        }
      }
      // Counts exhausted or a malformed row: close the hunk and fall through.
      endHunk()
    }
    if (inBinaryPayload) {
      if (line === "" || /^(?:literal|delta) \d+$/.test(line)) {
        inBinaryPayload = /^literal |^delta /.test(line)
        if (inBinaryPayload && section) section.binaryPayloadLines++
        continue
      }
      if (section) {
        section.binaryPayloadLines++
        continue
      }
    }
    const meta = section && META_RES.find(({ re }) => re.test(line))
    if (meta && section) {
      meta.apply(meta.re.exec(line)!, section)
      section.metaLines.push(line)
      continue
    }
    if (
      section &&
      /^(?:index |--- |\+\+\+ |similarity index |dissimilarity index |copy from |copy to )/.test(
        line
      )
    ) {
      section.metaLines.push(line)
      continue
    }
    if (section && /^(?:literal|delta) \d+$/.test(line)) {
      inBinaryPayload = true
      section.binaryPayloadLines++
      continue
    }
    pushOrphan(line)
  }
  endHunk()
  return parsed
}

/** Parse an RGB-ish colour value (`#rrggbb` or `rgb(r,g,b)`). */
function parseColor(value: string | undefined): [number, number, number] | null {
  if (!value) return null
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

function toHex([r, g, b]: [number, number, number]): string {
  const p = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0")
  return `#${p(r)}${p(g)}${p(b)}`
}

/**
 * Mix `color` toward black (dark themes) or white (light themes) so it can sit
 * behind text as a tint. `keep` is the share of the role colour retained —
 * lower is subtler. Non-RGB values (ANSI names) return undefined: their tinted
 * variant cannot be computed, and callers degrade to emphasis without a fill.
 */
export function mixColor(
  color: string | undefined,
  toward: "black" | "white",
  keep: number
): string | undefined {
  const rgb = parseColor(color)
  if (!rgb) return undefined
  const target = toward === "black" ? 0 : 255
  return toHex([
    rgb[0] * keep + target * (1 - keep),
    rgb[1] * keep + target * (1 - keep),
    rgb[2] * keep + target * (1 - keep),
  ])
}

interface PatchColors {
  add: string
  del: string
  muted: string
  accent: string
  info: string
  addBg?: string
  delBg?: string
  addHot?: string
  delHot?: string
  hunkBg?: string
  emptyBg?: string
  codeTheme?: ReturnType<typeof paletteCodeTheme>
}

function patchColors(palette: ThemePalette | undefined): PatchColors {
  const add = palette?.diffAdded ?? "green"
  const del = palette?.diffRemoved ?? "red"
  const info = palette?.info ?? "blue"
  const muted = palette?.muted ?? "gray"
  // Light text implies a dark terminal (mix toward black); dark text or an
  // unset `text` implies a light/unknown surface (mix toward white… reversed:
  // unknown defaults to black, matching the dark-first built-in themes).
  const textRgb = parseColor(palette?.text)
  const toward =
    textRgb && (textRgb[0] * 0.2126 + textRgb[1] * 0.7152 + textRgb[2] * 0.0722) / 255 < 0.5
      ? "white"
      : "black"
  return {
    add,
    del,
    muted,
    accent: palette?.accent ?? "cyan",
    info,
    // GitHub keeps row tints faint (≈20% of the role colour into the surface)
    // and reserves a slightly stronger wash (≈45%) for the changed-word
    // highlight — anything higher reads as a solid block behind the code.
    addBg: mixColor(add, toward, 0.2),
    delBg: mixColor(del, toward, 0.2),
    addHot: mixColor(add, toward, 0.45),
    delHot: mixColor(del, toward, 0.45),
    hunkBg: mixColor(info, toward, 0.22),
    emptyBg: mixColor(muted, toward, 0.12),
    codeTheme: palette ? paletteCodeTheme(palette) : undefined,
  }
}

const span = (
  text: string,
  style: TerminalSpan["style"],
  extra?: Partial<TerminalSpan>
): TerminalSpan => ({ text, style, ...extra })

/** Split highlighted-code spans at changed-token boundaries and emphasise them. */
function emphasise(
  codeSpans: TerminalSpan[],
  segments: PatchSegment[] | undefined,
  hotBg: string | undefined
): TerminalSpan[] {
  if (!segments) return codeSpans
  const flags: boolean[] = []
  for (const segment of segments)
    for (let i = 0; i < segment.text.length; i++) flags.push(segment.hot === true)
  const out: TerminalSpan[] = []
  let pos = 0
  for (const source of codeSpans) {
    let runStart = 0
    for (let i = 1; i <= source.text.length; i++) {
      if (i === source.text.length || flags[pos + i] !== flags[pos + runStart]) {
        const hot = flags[pos + runStart] === true
        const text = source.text.slice(runStart, i)
        out.push(
          hot
            ? {
                ...source,
                text,
                bold: true,
                ...(hotBg ? { background: hotBg } : { underline: true }),
              }
            : { ...source, text }
        )
        runStart = i
      }
    }
    pos += source.text.length
  }
  return out
}

/** Set a background on every span missing one and pad the row to `width`. */
function paintRow(line: TerminalLine, bg: string | undefined, width: number): TerminalLine {
  if (!bg) return line
  const spans = line.spans.map((s) => (s.background === undefined ? { ...s, background: bg } : s))
  const used = terminalStringWidth(line.plain)
  if (used < width) spans.push(span(" ".repeat(width - used), "plain", { background: bg }))
  return { spans, plain: spans.map((s) => s.text).join("") }
}

interface FileShape {
  sections: { input: PatchSectionInput; parsed: ParsedPatchSection }[]
  preamble: string[]
  digits: number
  additions: number
  deletions: number
}

/** Parse every section body once and derive the shared gutter width + totals. */
function shape(sections: PatchSectionInput[]): FileShape {
  const out: FileShape = { sections: [], preamble: [], digits: 2, additions: 0, deletions: 0 }
  let maxNo = 0
  for (const input of sections) {
    const parsed = parsePatchBody(input.body)
    out.preamble.push(...parsed.preamble)
    for (const section of parsed.sections) {
      out.sections.push({ input, parsed: section })
      for (const hunk of section.hunks) {
        for (const row of hunk.rows) {
          if (row.kind === "add") out.additions++
          if (row.kind === "del") out.deletions++
          maxNo = Math.max(maxNo, row.oldNo ?? 0, row.newNo ?? 0)
        }
      }
    }
  }
  out.digits = Math.max(2, String(maxNo).length)
  return out
}

/** Per-hunk syntax highlight: one call per hunk keeps multi-line constructs. */
function highlightHunk(
  hunk: PatchHunk,
  lang: string | undefined,
  codeTheme: PatchColors["codeTheme"]
): TerminalSpan[][] | null {
  if (!lang) return null
  const code = hunk.rows.map((row) => row.text).join("\n")
  const highlighted = highlightCode(code, lang, codeTheme)
  return highlighted.split("\n").map((line) => ansiToSpans(line, "plain"))
}

/** Row spans for one code line: gutter numbers + sign + code (no bg yet). */
function codeSpans(
  row: PatchRow,
  highlighted: TerminalSpan[] | null,
  colors: PatchColors
): TerminalSpan[] {
  const role = row.kind === "add" ? colors.add : row.kind === "del" ? colors.del : undefined
  const hotBg = row.kind === "add" ? colors.addHot : colors.delHot
  if (!highlighted) {
    const base = emphasise(
      row.segments
        ? row.segments.map((s) => span(s.text, "plain", role ? { color: role } : undefined))
        : [span(row.text, "plain", role ? { color: role } : undefined)],
      row.segments,
      hotBg
    )
    return base
  }
  return emphasise(highlighted, row.segments, hotBg)
}

interface RenderContext {
  colors: PatchColors
  digits: number
  width: number
  translate: PatchViewOptions["translate"]
}

/** Number/sign gutter prefix cells for a code row (unified layout). */
function gutterSpans(row: PatchRow, ctx: RenderContext): TerminalSpan[] {
  const oldTxt = row.kind !== "add" && row.oldNo !== undefined ? String(row.oldNo) : ""
  const newTxt = row.kind !== "del" && row.newNo !== undefined ? String(row.newNo) : ""
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "
  const role = row.kind === "add" ? ctx.colors.add : row.kind === "del" ? ctx.colors.del : undefined
  return [
    span(`${oldTxt.padStart(ctx.digits)} ${newTxt.padStart(ctx.digits)} `, "muted"),
    span(`${sign} `, "muted", role ? { color: role, bold: true } : undefined),
  ]
}

const gutterWidth = (ctx: RenderContext) => ctx.digits * 2 + 4

function pushWrapped(
  out: TerminalLine[],
  prefix: TerminalSpan[],
  content: TerminalSpan[],
  ctx: RenderContext,
  bg?: string
): void {
  const prefixCells = terminalStringWidth(prefix.map((s) => s.text).join(""))
  const rows = wrapTerminalSpans(content, Math.max(1, ctx.width - prefixCells))
  rows.forEach((row, i) => {
    const indent = i === 0 || prefixCells === 0 ? [] : [span(" ".repeat(prefixCells), "muted")]
    const line: TerminalLine = {
      spans: [...(i === 0 ? prefix : indent), ...row.spans],
      plain: "",
    }
    line.plain = line.spans.map((s) => s.text).join("")
    out.push(paintRow(line, bg, ctx.width))
  })
}

function hunkHeaderRow(hunk: PatchHunk, ctx: RenderContext): TerminalLine {
  const spans = [
    span(" ".repeat(ctx.digits * 2 + 2), "muted"),
    span("┃ ", "muted", { color: ctx.colors.info }),
    span(hunk.header, "muted", { color: ctx.colors.info, bold: true }),
  ]
  if (hunk.context) spans.push(span(` ${hunk.context}`, "muted"))
  const line: TerminalLine = { spans, plain: spans.map((s) => s.text).join("") }
  return paintRow(line, ctx.colors.hunkBg, ctx.width)
}

/** Chips on a section header: label (scope), file status, +/- stats. */
function sectionHeaderRow(
  input: PatchSectionInput,
  section: ParsedPatchSection,
  ctx: RenderContext,
  showLabel: boolean
): TerminalLine | null {
  const parts: TerminalSpan[] = []
  if (showLabel && input.label) parts.push(span(input.label, "accent"))
  if (section.status === "added")
    parts.push(span(ctx.translate("statusNew"), "muted", { color: ctx.colors.add }))
  else if (section.status === "deleted")
    parts.push(span(ctx.translate("statusDeleted"), "muted", { color: ctx.colors.del }))
  else if (section.status === "renamed")
    parts.push(
      span(
        section.renameFrom
          ? ctx.translate("statusRenamedFrom", { from: section.renameFrom })
          : ctx.translate("statusRenamed"),
        "muted",
        { color: ctx.colors.info }
      )
    )
  else if (section.status === "binary")
    parts.push(span(ctx.translate("binary"), "muted", { color: ctx.colors.info }))
  else if (section.status === "mode" && section.modeChange)
    parts.push(
      span(
        ctx.translate("modeChange", { from: section.modeChange.from, to: section.modeChange.to }),
        "muted",
        { color: ctx.colors.info }
      )
    )
  if (section.binaryPayloadLines > 0)
    parts.push(span(ctx.translate("binaryData", { count: section.binaryPayloadLines }), "muted"))
  if (parts.length === 0) return null
  const chips = intersperse(parts, span(" · ", "muted"))
  const used = 2 + terminalStringWidth(chips.map((s) => s.text).join("")) + 1
  const spans = [
    span("─ ", "muted"),
    ...chips,
    span(" " + "─".repeat(Math.max(1, ctx.width - used)), "muted"),
  ]
  return { spans, plain: spans.map((s) => s.text).join("") }
}

function intersperse(spans: TerminalSpan[], joiner: TerminalSpan): TerminalSpan[] {
  const out: TerminalSpan[] = []
  spans.forEach((s, i) => {
    if (i > 0) out.push({ ...joiner })
    out.push(s)
  })
  return out
}

/** Left/right half of a split row: its own number gutter, sign and clipped code. */
interface SplitCell {
  row?: PatchRow
  side: "old" | "new"
}

function splitCellSpans(
  cell: SplitCell,
  highlighted: TerminalSpan[] | null,
  ctx: RenderContext,
  cellWidth: number
): TerminalSpan[] {
  const { row } = cell
  if (!row) return [span(" ".repeat(cellWidth), "plain")]
  const num =
    cell.side === "old"
      ? row.kind !== "add" && row.oldNo !== undefined
        ? String(row.oldNo)
        : ""
      : row.kind !== "del" && row.newNo !== undefined
        ? String(row.newNo)
        : ""
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "
  const role = row.kind === "add" ? ctx.colors.add : row.kind === "del" ? ctx.colors.del : undefined
  const gutter = [
    span(`${num.padStart(ctx.digits)} `, "muted"),
    span(`${sign} `, "muted", role ? { color: role, bold: true } : undefined),
  ]
  const code = codeSpans(row, highlighted, ctx.colors)
  const codeWidth = Math.max(1, cellWidth - ctx.digits - 3)
  const clipped = truncateTerminalSpans(code, codeWidth)
  const codePart =
    clipped.truncated && codeWidth >= 2
      ? [...truncateTerminalSpans(code, codeWidth - 1).spans, span("…", "muted")]
      : clipped.spans
  const spans = [...gutter, ...codePart]
  const used = terminalStringWidth(spans.map((s) => s.text).join(""))
  if (used < cellWidth) spans.push(span(" ".repeat(cellWidth - used), "plain"))
  return spans
}

/** Pair a hunk's rows into split cells (del | add) like GitHub's split view. */
function splitPairs(rows: PatchRow[]): Array<{ old?: PatchRow; next?: PatchRow; meta?: PatchRow }> {
  const out: Array<{ old?: PatchRow; next?: PatchRow; meta?: PatchRow }> = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.kind === "context") {
      out.push({ old: row, next: row })
      i++
      continue
    }
    if (row.kind === "meta") {
      out.push({ meta: row })
      i++
      continue
    }
    let j = i
    while (rows[j]?.kind === "del") j++
    let k = j
    while (rows[k]?.kind === "add") k++
    const dels = rows.slice(i, j)
    const adds = rows.slice(j, k)
    const n = Math.max(dels.length, adds.length)
    for (let p = 0; p < n; p++) out.push({ old: dels[p], next: adds[p] })
    i = k
  }
  return out
}

/** Render the parsed shape into TerminalLines for the chosen layout. */
export function preparePatchLines(
  sections: PatchSectionInput[],
  options: PatchViewOptions
): PreparedPatch {
  const ctx: RenderContext = {
    colors: patchColors(options.palette),
    digits: 2,
    width: Math.max(8, Math.floor(options.width)),
    translate: options.translate,
  }
  const file = shape(sections)
  ctx.digits = file.digits
  const out: TerminalLine[] = []
  const hunkRows: number[] = []

  for (const line of file.preamble) {
    pushWrapped(out, [], [span(line || " ", "muted")], ctx)
  }

  const showLabel = sections.filter((s) => s.label).length > 1
  for (const { input, parsed } of file.sections) {
    const header = sectionHeaderRow(input, parsed, ctx, showLabel)
    if (header) out.push(header)
    const highlightedByRow = new Map<PatchRow, TerminalSpan[]>()
    for (const hunk of parsed.hunks) {
      const highlighted = highlightHunk(hunk, options.lang, ctx.colors.codeTheme)
      if (highlighted)
        hunk.rows.forEach((row, index) => highlightedByRow.set(row, highlighted[index]))
    }
    let hunkIndex = 0
    const flushOrphans = () => {
      for (const orphan of parsed.orphans.filter((o) => o.afterHunks === hunkIndex)) {
        pushWrapped(
          out,
          [span(" ".repeat(gutterWidth(ctx)), "muted")],
          [span(orphan.line, "muted")],
          ctx
        )
      }
    }
    flushOrphans()
    for (const hunk of parsed.hunks) {
      hunkIndex++
      hunkRows.push(out.length)
      out.push(hunkHeaderRow(hunk, ctx))
      if (options.layout === "split") {
        for (const pair of splitPairs(hunk.rows)) {
          if (pair.meta) {
            pushWrapped(
              out,
              [span(" ".repeat(ctx.digits * 2 + 2), "muted"), span("\\ ", "muted")],
              [span(pair.meta.text, "muted")],
              ctx
            )
            continue
          }
          const leftW = Math.floor((ctx.width - 3) / 2)
          const rightW = ctx.width - 3 - leftW
          const left = pair.old
            ? splitCellSpans(
                { row: pair.old, side: "old" },
                highlightedByRow.get(pair.old) ?? null,
                ctx,
                leftW
              )
            : [
                span(
                  " ".repeat(leftW),
                  "plain",
                  ctx.colors.emptyBg ? { background: ctx.colors.emptyBg } : undefined
                ),
              ]
          const right = pair.next
            ? splitCellSpans(
                { row: pair.next, side: "new" },
                highlightedByRow.get(pair.next) ?? null,
                ctx,
                rightW
              )
            : [
                span(
                  " ".repeat(rightW),
                  "plain",
                  ctx.colors.emptyBg ? { background: ctx.colors.emptyBg } : undefined
                ),
              ]
          const bgOf = (row?: PatchRow) =>
            row?.kind === "add"
              ? ctx.colors.addBg
              : row?.kind === "del"
                ? ctx.colors.delBg
                : undefined
          const paintCell = (spans: TerminalSpan[], row: PatchRow | undefined) => {
            const bg = bgOf(row)
            return bg
              ? spans.map((s) => (s.background === undefined ? { ...s, background: bg } : s))
              : spans
          }
          const spans = [
            ...paintCell(left, pair.old),
            span(" │ ", "muted"),
            ...paintCell(right, pair.next),
          ]
          out.push({ spans, plain: spans.map((s) => s.text).join("") })
        }
      } else {
        for (const row of hunk.rows) {
          if (row.kind === "meta") {
            pushWrapped(
              out,
              [span(" ".repeat(ctx.digits * 2 + 2), "muted"), span("\\ ", "muted")],
              [span(row.text, "muted")],
              ctx
            )
            continue
          }
          const bg =
            row.kind === "add"
              ? ctx.colors.addBg
              : row.kind === "del"
                ? ctx.colors.delBg
                : undefined
          pushWrapped(
            out,
            gutterSpans(row, ctx),
            codeSpans(row, highlightedByRow.get(row) ?? null, ctx.colors),
            ctx,
            bg
          )
        }
      }
      flushOrphans()
    }
    // Orphans recorded after the final hunk (or in a hunk-less section).
    for (const orphan of parsed.orphans.filter((o) => o.afterHunks > hunkIndex)) {
      pushWrapped(
        out,
        [span(" ".repeat(gutterWidth(ctx)), "muted")],
        [span(orphan.line, "muted")],
        ctx
      )
    }
  }
  return { lines: out, hunkRows }
}
