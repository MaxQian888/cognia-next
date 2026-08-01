/**
 * i18n lint — guards against translation regressions across the codebase.
 *
 * Two checks run per invocation:
 *
 *   1. **Key parity** — `i18n/messages/en.json` and `i18n/messages/zh-CN.json`
 *      must declare the same flattened dot-path key set. Any key on one side
 *      but not the other is reported and exits non-zero.
 *
 *   2. **Hard-coded UI string scan** — every `.tsx` file under `components/`,
 *      `app/`, and `hooks/` is parsed with the TypeScript compiler API. JSX
 *      text nodes and JSX attribute values for `placeholder`, `aria-label`,
 *      `title`, and `alt` are inspected for literal strings that look
 *      user-facing (contain letters beyond a small allowed character class).
 *
 *      Existing tech-debt strings are snapshotted into
 *      `scripts/i18n-baseline.json` so the gate can be introduced without
 *      blocking unrelated work. Any new finding above the baseline count
 *      fails the lint.
 *
 *   3. **Referenced-key existence** — every literal `t("key")` (and `t.rich`,
 *      `t.raw`, `t.markup`, `t.has`) reachable through a
 *      `const t = useTranslations("ns")` / `getTranslations("ns")` binding is
 *      resolved to its full dot-path and must exist in BOTH locale files (a
 *      proper prefix of an existing key also counts, covering `t.raw` subtree
 *      roots). Non-literal keys are reported informationally, never failed.
 *      Pre-existing gaps live in the baseline's `knownMissingKeyRefs`.
 *
 * Inline escape (both modes): a finding whose line — or the line directly
 * above it — carries `// i18n-exempt: <reason>` (or the `{/* … *\/}` JSX
 * comment form) is suppressed. A bare marker without a reason exempts nothing.
 *
 * Flags:
 *   --write-baseline   Refresh the baseline from current findings.
 *                      Use sparingly — running this defeats the gate for
 *                      anything it captures.
 *   --json             Emit a structured report to stdout (one JSON object).
 *   --staged           Scan ONLY staged .tsx files (git diff --cached) with
 *                      zero tolerance for hardcoded strings — no baseline
 *                      count, no parity/key-existence pass. Fast pre-commit
 *                      mode; exits 0 immediately when nothing relevant is
 *                      staged.
 *
 * Exit codes (bitmask): 0 = green, 1 = key drift, 2 = JSX hardcoded strings
 * above baseline (or any staged finding in --staged mode), 4 = referenced
 * keys missing from a locale file.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import * as ts from "typescript"

interface JsxFinding {
  file: string
  line: number
  column: number
  context: "jsx-text" | "placeholder" | "aria-label" | "title" | "alt"
  text: string
}

interface BaselineFile {
  /** Total count snapshot for JSX hard-coded strings. */
  count: number
  /** First-N samples for human readability. */
  samples: Array<Omit<JsxFinding, "line" | "column">>
  /** Snapshot of pre-existing key parity drift (en/zh). New drift fails;
   * keys already on this list are tolerated until the underlying
   * translation gap is closed. */
  knownParityDrift?: {
    onlyInEn: string[]
    onlyInZh: string[]
  }
  /** Pre-existing referenced-key gaps (`t("…")` whose resolved key is absent
   * from a locale file). New gaps fail; listed keys are tolerated until the
   * missing translations land. Refreshed by --write-baseline. */
  knownMissingKeyRefs?: string[]
}

const REPO_ROOT = path.resolve(__dirname, "../..")
const I18N_EN = path.join(REPO_ROOT, "i18n/messages/en.json")
const I18N_ZH = path.join(REPO_ROOT, "i18n/messages/zh-CN.json")
const BASELINE_PATH = path.join(REPO_ROOT, "scripts/i18n-baseline.json")
const IGNORE_PATH = path.join(REPO_ROOT, "scripts/i18n-ignore.txt")

const SCAN_DIRS = ["components", "app", "hooks"]
// Folders that are vendored / outside our authorship — never flag.
const VENDORED_PREFIXES = ["components/ui/", "components/ai-elements/"]

// Strings shorter than this length are assumed non-prose (icons, codes).
const MIN_LEN = 3

/** A literal counts as "translation-worthy" if it contains at least one
 * letter-like rune that is NOT decorative whitespace, digits, punctuation,
 * symbols, or a single accented glyph. The regex is intentionally
 * conservative — false positives here are friction, false negatives are
 * silent regressions. Tune the ignore file rather than this character class. */
const PROSE_RE = /[A-Za-z一-鿿]{2,}/

// JSX attribute names whose string values are user-visible.
const VISIBLE_ATTRS = new Set(["placeholder", "aria-label", "title", "alt"])

// ---------------------------------------------------------------------------
// Key parity
// ---------------------------------------------------------------------------

function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return prefix ? [prefix] : []
  if (Array.isArray(obj)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v, next))
    } else {
      out.push(next)
    }
  }
  return out
}

export interface ParityDiff {
  onlyInEn: string[]
  onlyInZh: string[]
}

export function diffKeys(
  enRaw: Record<string, unknown>,
  zhRaw: Record<string, unknown>
): ParityDiff {
  const en = new Set(flattenKeys(enRaw))
  const zh = new Set(flattenKeys(zhRaw))
  return {
    onlyInEn: [...en].filter((k) => !zh.has(k)).sort(),
    onlyInZh: [...zh].filter((k) => !en.has(k)).sort(),
  }
}

// ---------------------------------------------------------------------------
// JSX scan
// ---------------------------------------------------------------------------

function shouldIgnoreFile(relPath: string, ignoreGlobs: string[]): boolean {
  if (VENDORED_PREFIXES.some((p) => relPath.startsWith(p))) return true
  for (const g of ignoreGlobs) {
    if (!g || g.startsWith("#")) continue
    // Treat patterns as simple substring matches — keeps the ignore file
    // human-readable and avoids dragging in a glob dependency.
    if (relPath.includes(g)) return true
  }
  return false
}

function listSourceFiles(): string[] {
  const out: string[] = []
  const walk = (abs: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(abs, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".next" || ent.name === "out") continue
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      if (!ent.name.endsWith(".tsx")) continue
      if (ent.name.endsWith(".test.tsx")) continue
      if (ent.name.endsWith(".stories.tsx")) continue
      out.push(full)
    }
  }
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir))
  return out
}

/** Strings that look like technical placeholders rather than UI prose.
 *
 *  - http(s) URLs and bare hostnames + ports (e.g. `192.168.1.42:7891`)
 *  - JWT prefixes (`eyJ…`)
 *  - kebab/dot-cased identifiers with version digits (`claude-sonnet-4-6`,
 *    `gpt-4.1-mini`)
 *  - hex / base64 / uuid blobs
 *
 *  These appear in <input placeholder> values as example payloads and must
 *  not be translated — translating them would break the UX hint.
 */
const TECHNICAL_PATTERNS: RegExp[] = [
  /^https?:\/\//i,
  /^[a-z0-9.-]+:\d{2,5}$/i, // bare host:port
  /^eyJ[A-Za-z0-9_-]*\.?/, // JWT prefix
  /^[a-z][a-z0-9]*(-[a-z0-9.]+){2,}$/i, // model-id style: claude-sonnet-4-6, gpt-4-mini
  /^[0-9a-f]{12,}$/i, // long hex
  /^[A-Fa-f0-9-]{8,}-[A-Fa-f0-9-]{4,}-/, // uuid-ish
]

function isTechnicalLiteral(s: string): boolean {
  for (const re of TECHNICAL_PATTERNS) if (re.test(s)) return true
  return false
}

function isProseLiteral(s: string): boolean {
  const trimmed = s.trim()
  if (trimmed.length < MIN_LEN) return false
  if (isTechnicalLiteral(trimmed)) return false
  return PROSE_RE.test(trimmed)
}

function recordPos(source: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = source.getLineAndCharacterOfPosition(pos)
  return { line: line + 1, column: character + 1 }
}

/** Inline escape: `// i18n-exempt: <reason>` or `{/* i18n-exempt: <reason> *\/}`
 * on the finding's line or the line directly above. A bare marker (no reason)
 * exempts nothing. */
const I18N_EXEMPT_RE = /i18n-exempt:([^*\n]*)/

function isLineExempt(lines: string[], line: number): boolean {
  for (const idx of [line - 1, line - 2]) {
    if (idx < 0 || idx >= lines.length) continue
    const m = lines[idx].match(I18N_EXEMPT_RE)
    // The captured reason stops before a `*` so a bare `{/* i18n-exempt: */}`
    // cannot pass its own comment terminator off as a reason.
    if (m && m[1].trim() !== "") return true
  }
  return false
}

function scanFile(absPath: string): JsxFinding[] {
  const rel = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/")
  const sourceText = fs.readFileSync(absPath, "utf8")
  const source = ts.createSourceFile(
    rel,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const findings: JsxFinding[] = []

  const visit = (node: ts.Node) => {
    // JSX text content (between tags).
    if (ts.isJsxText(node)) {
      const text = node.text
      if (isProseLiteral(text)) {
        const { line, column } = recordPos(source, node.getStart(source))
        findings.push({ file: rel, line, column, context: "jsx-text", text: text.trim() })
      }
    }

    // JSX attribute with a string-literal value: name + "Hi"
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(source)
      if (VISIBLE_ATTRS.has(name)) {
        if (ts.isStringLiteral(node.initializer)) {
          const text = node.initializer.text
          if (isProseLiteral(text)) {
            const { line, column } = recordPos(source, node.initializer.getStart(source))
            findings.push({
              file: rel,
              line,
              column,
              context: name as JsxFinding["context"],
              text,
            })
          }
        } else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isStringLiteral(node.initializer.expression)
        ) {
          const text = node.initializer.expression.text
          if (isProseLiteral(text)) {
            const { line, column } = recordPos(source, node.initializer.expression.getStart(source))
            findings.push({
              file: rel,
              line,
              column,
              context: name as JsxFinding["context"],
              text,
            })
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  const lines = sourceText.split("\n")
  return findings.filter((f) => !isLineExempt(lines, f.line))
}

// ---------------------------------------------------------------------------
// Referenced-key existence
// ---------------------------------------------------------------------------

export interface KeyRef {
  file: string
  line: number
  key: string
}

interface KeyRefScan {
  refs: KeyRef[]
  dynamicCount: number
}

const T_METHODS = new Set(["rich", "raw", "markup", "has"])

/**
 * Resolve literal translation-key references in one source file.
 *
 * Handles the binding convention `const t = useTranslations("ns")` /
 * `const t = await getTranslations("ns")` (also the
 * `getTranslations({ namespace: "ns" })` object form). Calls through the
 * binding — `t("key")`, `t.rich("key", …)` etc. — with a literal first
 * argument resolve to `ns.key`. Non-literal first arguments count as dynamic
 * (reported, never failed). A binding name re-declared with a DIFFERENT
 * namespace in the same file is dropped entirely (its calls are unresolvable
 * without scope analysis — honest v1 limitation).
 */
export function extractKeyRefs(source: ts.SourceFile, rel: string): KeyRefScan {
  const nsByBinding = new Map<string, string>()
  const ambiguous = new Set<string>()

  const namespaceFromCall = (call: ts.CallExpression): string | null => {
    const arg = call.arguments[0]
    if (!arg) return ""
    if (ts.isStringLiteralLike(arg)) return arg.text
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "namespace" &&
          ts.isStringLiteralLike(prop.initializer)
        ) {
          return prop.initializer.text
        }
      }
      return ""
    }
    return null // non-literal namespace — binding unusable
  }

  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      let init: ts.Expression = node.initializer
      if (ts.isAwaitExpression(init)) init = init.expression
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        (init.expression.text === "useTranslations" || init.expression.text === "getTranslations")
      ) {
        const ns = namespaceFromCall(init)
        const name = node.name.text
        if (ns === null) {
          ambiguous.add(name)
        } else if (nsByBinding.has(name) && nsByBinding.get(name) !== ns) {
          ambiguous.add(name)
        } else {
          nsByBinding.set(name, ns)
        }
      }
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(source)
  for (const name of ambiguous) nsByBinding.delete(name)

  const refs: KeyRef[] = []
  let dynamicCount = 0

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let bindingName: string | null = null
      const callee = node.expression
      if (ts.isIdentifier(callee)) {
        bindingName = callee.text
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        T_METHODS.has(callee.name.text)
      ) {
        bindingName = callee.expression.text
      }
      if (bindingName && nsByBinding.has(bindingName)) {
        const ns = nsByBinding.get(bindingName) as string
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) {
          const { line } = source.getLineAndCharacterOfPosition(arg.getStart(source))
          refs.push({ file: rel, line: line + 1, key: ns ? `${ns}.${arg.text}` : arg.text })
        } else if (arg) {
          dynamicCount += 1
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { refs, dynamicCount }
}

/** Every flattened key plus every dot-path prefix of it, for membership tests
 * that must accept subtree roots (`t.raw("chat.errors")`). */
export function buildKeyPrefixSet(flat: string[]): Set<string> {
  const out = new Set<string>()
  for (const key of flat) {
    const parts = key.split(".")
    let acc = ""
    for (const part of parts) {
      acc = acc ? `${acc}.${part}` : part
      out.add(acc)
    }
  }
  return out
}

export function scanKeyRefs(
  files: string[],
  ignoreGlobs: string[]
): { refs: KeyRef[]; dynamicCount: number } {
  const refs: KeyRef[] = []
  let dynamicCount = 0
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f).replace(/\\/g, "/")
    if (shouldIgnoreFile(rel, ignoreGlobs)) continue
    const sourceText = fs.readFileSync(f, "utf8")
    const source = ts.createSourceFile(
      rel,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const result = extractKeyRefs(source, rel)
    refs.push(...result.refs)
    dynamicCount += result.dynamicCount
  }
  return { refs, dynamicCount }
}

export function scanAllFiles(files: string[], ignoreGlobs: string[]): JsxFinding[] {
  const all: JsxFinding[] = []
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f).replace(/\\/g, "/")
    if (shouldIgnoreFile(rel, ignoreGlobs)) continue
    all.push(...scanFile(f))
  }
  return all
}

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

function loadBaseline(): BaselineFile | null {
  if (!fs.existsSync(BASELINE_PATH)) return null
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as BaselineFile
}

function writeBaseline(findings: JsxFinding[], parity: ParityDiff, missingKeyRefs: string[]): void {
  const samples = findings.slice(0, 50).map(({ file, context, text }) => ({ file, context, text }))
  const payload: BaselineFile = {
    count: findings.length,
    samples,
    knownParityDrift: {
      onlyInEn: parity.onlyInEn,
      onlyInZh: parity.onlyInZh,
    },
    knownMissingKeyRefs: [...new Set(missingKeyRefs)].sort(),
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n")
}

/** Subtract the baseline's tolerated drift from a fresh parity diff. */
export function filterAgainstBaseline(
  parity: ParityDiff,
  baseline: BaselineFile | null
): ParityDiff {
  const tolerated = baseline?.knownParityDrift
  if (!tolerated) return parity
  const enTol = new Set(tolerated.onlyInEn)
  const zhTol = new Set(tolerated.onlyInZh)
  return {
    onlyInEn: parity.onlyInEn.filter((k) => !enTol.has(k)),
    onlyInZh: parity.onlyInZh.filter((k) => !zhTol.has(k)),
  }
}

function loadIgnoreGlobs(): string[] {
  if (!fs.existsSync(IGNORE_PATH)) return []
  return fs
    .readFileSync(IGNORE_PATH, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export interface CliArgs {
  writeBaseline: boolean
  json: boolean
  staged: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  return {
    writeBaseline: argv.includes("--write-baseline"),
    json: argv.includes("--json"),
    staged: argv.includes("--staged"),
  }
}

/** Staged .tsx files (added/copied/modified/renamed) under SCAN_DIRS. */
function listStagedFiles(): string[] {
  const out = execSync("git diff --cached --name-only --diff-filter=ACMR", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx") && !p.endsWith(".stories.tsx"))
    .filter((p) => SCAN_DIRS.some((d) => p.startsWith(`${d}/`)))
    .map((p) => path.join(REPO_ROOT, p))
    .filter((p) => fs.existsSync(p))
}

/** Zero-tolerance scan of staged .tsx files only. Returns the exit code. */
function runStaged(): number {
  const staged = listStagedFiles()
  if (staged.length === 0) {
    console.log("[lint:i18n --staged] OK — no staged .tsx files to scan")
    return 0
  }
  const ignoreGlobs = loadIgnoreGlobs()
  const findings = scanAllFiles(staged, ignoreGlobs)
  if (findings.length === 0) {
    console.log(
      `[lint:i18n --staged] OK — ${staged.length} staged .tsx file(s), no hardcoded strings`
    )
    return 0
  }
  console.error(
    `[lint:i18n --staged] FAIL — ${findings.length} hardcoded string(s) in staged files ` +
      `(zero tolerance; use next-intl or \`// i18n-exempt: <reason>\`):`
  )
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}:${f.column} [${f.context}] ${JSON.stringify(f.text)}`)
  }
  return 2
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)

  // Fast pre-commit path: staged files only, zero tolerance, nothing else.
  if (args.staged) return runStaged()

  // 1. Key parity (raw — before baseline filtering).
  const en = JSON.parse(fs.readFileSync(I18N_EN, "utf8")) as Record<string, unknown>
  const zh = JSON.parse(fs.readFileSync(I18N_ZH, "utf8")) as Record<string, unknown>
  const rawParity = diffKeys(en, zh)

  // 2. JSX scan.
  const ignoreGlobs = loadIgnoreGlobs()
  const files = listSourceFiles()
  const findings = scanAllFiles(files, ignoreGlobs)

  // 3. Referenced-key existence: every literal t("…") key must exist in BOTH
  // locale files (or be a prefix of an existing key).
  const enKeys = buildKeyPrefixSet(flattenKeys(en))
  const zhKeys = buildKeyPrefixSet(flattenKeys(zh))
  const keyRefScan = scanKeyRefs(files, ignoreGlobs)
  const rawMissingRefs = keyRefScan.refs.filter((r) => !enKeys.has(r.key) || !zhKeys.has(r.key))

  if (args.writeBaseline) {
    writeBaseline(
      findings,
      rawParity,
      rawMissingRefs.map((r) => r.key)
    )
    console.log(
      `[lint:i18n] baseline written: ${findings.length} JSX findings, ` +
        `${rawParity.onlyInEn.length}/${rawParity.onlyInZh.length} known parity drift, ` +
        `${new Set(rawMissingRefs.map((r) => r.key)).size} known missing key refs`
    )
    return 0
  }

  const baseline = loadBaseline()
  const parity = filterAgainstBaseline(rawParity, baseline)
  const parityFailed = parity.onlyInEn.length > 0 || parity.onlyInZh.length > 0
  // If no baseline file exists, treat zero as the implicit cap so the
  // gate is meaningful on first introduction.
  const baselineCount = baseline?.count ?? 0
  const jsxFailed = findings.length > baselineCount

  const toleratedRefs = new Set(baseline?.knownMissingKeyRefs ?? [])
  const missingRefs = rawMissingRefs.filter((r) => !toleratedRefs.has(r.key))
  const keyRefsFailed = missingRefs.length > 0

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          parity,
          rawParity,
          parityFailed,
          jsxFindingCount: findings.length,
          baselineCount,
          jsxFailed,
          allFindings: findings,
          missingKeyRefs: missingRefs,
          dynamicKeyRefCount: keyRefScan.dynamicCount,
          keyRefsFailed,
        },
        null,
        2
      )
    )
    process.stdout.write("\n")
  } else {
    if (parityFailed) {
      console.error("[lint:i18n] FAIL — key parity drift between en and zh-CN (above baseline)")
      if (parity.onlyInEn.length) {
        console.error(`  Only in en (${parity.onlyInEn.length}):`)
        for (const k of parity.onlyInEn.slice(0, 20)) console.error(`    + ${k}`)
        if (parity.onlyInEn.length > 20) console.error(`    … ${parity.onlyInEn.length - 20} more`)
      }
      if (parity.onlyInZh.length) {
        console.error(`  Only in zh-CN (${parity.onlyInZh.length}):`)
        for (const k of parity.onlyInZh.slice(0, 20)) console.error(`    + ${k}`)
        if (parity.onlyInZh.length > 20) console.error(`    … ${parity.onlyInZh.length - 20} more`)
      }
    } else {
      const enTol = baseline?.knownParityDrift?.onlyInEn.length ?? 0
      const zhTol = baseline?.knownParityDrift?.onlyInZh.length ?? 0
      console.log(`[lint:i18n] OK — key parity (tolerated drift: ${enTol}/${zhTol})`)
    }

    if (jsxFailed) {
      console.error(
        `[lint:i18n] FAIL — JSX hardcoded strings: ${findings.length} (baseline ${baselineCount})`
      )
      for (const f of findings.slice(0, 10)) {
        console.error(`  ${f.file}:${f.line}:${f.column} [${f.context}] ${JSON.stringify(f.text)}`)
      }
      if (findings.length > 10) console.error(`  … ${findings.length - 10} more`)
    } else {
      console.log(
        `[lint:i18n] OK — JSX hardcoded strings: ${findings.length} (≤ baseline ${baselineCount})`
      )
    }

    if (keyRefsFailed) {
      console.error(
        `[lint:i18n] FAIL — ${missingRefs.length} referenced key(s) missing from a locale file:`
      )
      // Every one of these is a key someone has to go add, so the list is
      // printed in full — a truncated one just means running the gate twice.
      for (const r of missingRefs) {
        console.error(`  ${r.file}:${r.line}  t("${r.key}") — not in en.json and/or zh-CN.json`)
      }
    } else {
      console.log(
        `[lint:i18n] OK — referenced keys exist in both locales ` +
          `(${keyRefScan.refs.length} literal refs, ${keyRefScan.dynamicCount} dynamic skipped, ` +
          `${toleratedRefs.size} tolerated)`
      )
    }
  }

  let code = 0
  if (parityFailed) code |= 1
  if (jsxFailed) code |= 2
  if (keyRefsFailed) code |= 4
  return code
}

// Only auto-run when invoked directly (not when imported by tests).
if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code)
  })
}

// Re-export internals for tests.
export const __internal = {
  flattenKeys,
  scanFile,
  shouldIgnoreFile,
  isProseLiteral,
  listSourceFiles,
  extractKeyRefs,
  buildKeyPrefixSet,
  isLineExempt,
}
