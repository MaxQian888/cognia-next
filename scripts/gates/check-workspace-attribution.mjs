#!/usr/bin/env node
/**
 * Workspace-attribution gate — keeps two whole classes of defect from growing
 * back after they were paid down.
 *
 * ## 1. The focused-slice projection
 *
 * `useChatStore` keeps one slice per conversation and mirrors the FOCUSED one
 * onto the store's top level, so ~130 legacy call sites can read `s.status`,
 * `s.messages`, `s.pendingApprovals` and friends unchanged. That projection is
 * correct for a panel showing one conversation and a LIE for anything that
 * speaks for the whole app: the tray, the status bar and the mobile shell all
 * reported "idle" while two background turns were streaming, and the composer's
 * `appendMessage` wrote a split pane's slash-command echo into the pane beside
 * it.
 *
 * The fix was per-surface, not a mass migration, so this gate is a BASELINE:
 * the recorded reads are the ones that are legitimately about "the conversation
 * on screen". It may only shrink. A new read has to either key by session
 * (`useSessionStatus(id)`, `appendMessageToSession`, `aggregateRunState`) or be
 * added to the baseline with a reason.
 *
 * ## 2. The cwd chain
 *
 * A turn's working directory has exactly one resolution — `resolveEffectiveCwd`
 * / `resolvePanelRoot`, both fed by the session's `executionContext`. Before
 * that consolidation, six surfaces each derived it differently and a
 * conversation in a managed worktree got a terminal, an editor and a git panel
 * all pointing at the checkout it was cut from. A new `project.rootDir` read on
 * an execution path is how that comes back, so those reads are baselined too.
 *
 * Modes:
 *   (default)          fail on any offender absent from the baseline
 *   --write-baseline   rewrite the baseline from the current tree
 *
 * Usage:
 *   pnpm audit:workspace-attribution
 *   pnpm audit:workspace-attribution:baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")
const BASELINE_FILE = join(__dirname, "workspace-attribution-baseline.json")

const SCAN_ROOTS = ["components", "app", "hooks", "lib", "stores"]

/**
 * Exempt by design:
 *  - the chat store IS the projection, and its own tests assert on it;
 *  - `lib/chat/aggregate-run-state.ts` exists to read the whole session map;
 *  - tests and stories set up the very state this gate is about.
 */
const EXEMPT_PREFIXES = [
  "stores/chat/chat-store.ts",
  "lib/chat/aggregate-run-state.ts",
  "lib/workspace/",
  "lib/execution/slot-key.ts",
]

const EXEMPT_SUFFIXES = [".test.ts", ".test.tsx", ".stories.tsx", ".d.ts"]

/**
 * Top-level projection reads. Deliberately matched on the SELECTOR shape rather
 * than the field name alone: `s.status` inside a selector is the projection,
 * while `slice.status` or `row.status` is somebody's own object.
 */
const PROJECTION_FIELDS = [
  "status",
  "messages",
  "errorMessage",
  "errorDiagnostic",
  "pendingApprovals",
  "messagesLoading",
  "messagesLoadError",
  "messagesReloadNonce",
  "activeBranchByGroup",
  // The composer-draft half. These moved into the slice at the same time as
  // the rest and were missed here, so a per-pane control could read the focused
  // projection and the gate said OK — which is exactly how the composer ended
  // up writing to its own conversation and reading the one beside it.
  // Keep in step with `ProjectedField` in stores/chat/chat-store.ts.
  "permissionMode",
  "referencedPaths",
  "referencedWorkflowElements",
  "referencedDocs",
  "contextSelections",
  "pendingCommandOverrides",
  "webSearchOnForNextSend",
  "ephemeralSkillIds",
  "bookmarkedIds",
]

const PROJECTION_RE = new RegExp(
  `useChatStore\\(\\s*\\(\\s*s(?:tate)?\\s*\\)\\s*=>\\s*s(?:tate)?\\.(${PROJECTION_FIELDS.join("|")})\\b`,
  "g"
)

/**
 * Legacy cwd derivations. `rootDir` is the deprecated mirror of the primary
 * root (`primaryRootOf`), and every remaining read of it on an execution path
 * is a place the execution context is being bypassed.
 *
 * The receiver is matched by SHAPE — any identifier ending in `project` or
 * `workspace`, plus the bare `p` — rather than as the fixed list of three names
 * it used to be (`project|workspace|p`). `activeProject.rootDir`, the spelling
 * the terminal dock and the git indicator actually use, sailed straight through
 * the gate meant to catch it. Deliberately not `\w*`: the git store has a
 * `rootDir` of its own that is the bound repository, not a workspace mirror,
 * and folding those in would bury the real offenders under thirty false ones.
 *
 * `resolveSessionProjectRoot` is the same defect one level up. It answers "the
 * workspace's primary root", which is a legitimate DISPLAY question and a wrong
 * EXECUTION one; five surfaces were on it and `edit-review-bridge` failed
 * silently, comparing an agent's absolute path against the workspace root so
 * every worktree edit failed the containment check and "open in review" did
 * nothing at all. The execution answer is `resolveSessionExecutionRoot` /
 * `sessionExecutionRootPath` (`lib/workspace/session-root.ts`).
 */
const CWD_RE =
  /\b(?:\w*[Pp]roject|\w*[Ww]orkspace|p)\??\.(?:rootDir|additionalDirs)\b|\bresolveSessionProjectRoot\s*\(/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

function isExempt(rel) {
  if (EXEMPT_SUFFIXES.some((suffix) => rel.endsWith(suffix))) return true
  return EXEMPT_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix))
}

/** `{ [relPath]: { projection: number, cwd: number } }` for every offender. */
export function collectOffenders(root = ROOT) {
  const offenders = {}
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot)
    if (!existsSync(dir)) continue
    for (const file of walk(dir)) {
      const rel = relative(root, file).split("\\").join("/")
      if (isExempt(rel)) continue
      const source = readFileSync(file, "utf8")
      const projection = (source.match(PROJECTION_RE) ?? []).length
      const cwd = (source.match(CWD_RE) ?? []).length
      if (projection > 0 || cwd > 0) offenders[rel] = { projection, cwd }
    }
  }
  return offenders
}

/**
 * Compare against the baseline.
 *
 * A file may hold FEWER offences than recorded (that is progress) but never
 * more, and a file absent from the baseline may hold none at all.
 */
export function diffAgainstBaseline(offenders, baseline) {
  const added = []
  const grew = []
  for (const [file, counts] of Object.entries(offenders)) {
    const recorded = baseline[file]
    if (!recorded) {
      added.push({ file, counts })
      continue
    }
    if (counts.projection > recorded.projection || counts.cwd > recorded.cwd) {
      grew.push({ file, counts, recorded })
    }
  }
  const fixed = Object.keys(baseline).filter((file) => !offenders[file])
  return { added, grew, fixed }
}

function main() {
  const write = process.argv.includes("--write-baseline")
  const offenders = collectOffenders()

  if (write) {
    const sorted = Object.fromEntries(
      Object.entries(offenders).sort(([a], [b]) => a.localeCompare(b))
    )
    writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`)
    const total = Object.values(sorted).reduce((sum, c) => sum + c.projection + c.cwd, 0)
    console.log(
      `[workspace-attribution] baseline written: ${Object.keys(sorted).length} file(s), ${total} occurrence(s)`
    )
    return
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(
      "[workspace-attribution] no baseline — run `pnpm audit:workspace-attribution:baseline`"
    )
    process.exit(1)
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  const { added, grew, fixed } = diffAgainstBaseline(offenders, baseline)

  if (fixed.length > 0) {
    console.log(
      `[workspace-attribution] ${fixed.length} baselined file(s) now clean — rewrite the baseline to lock the gain in.`
    )
  }

  if (added.length === 0 && grew.length === 0) {
    const total = Object.values(offenders).reduce((sum, c) => sum + c.projection + c.cwd, 0)
    console.log(`[workspace-attribution] OK: ${total} known occurrence(s), none new.`)
    return
  }

  console.error("[workspace-attribution] FAIL — new focused-projection or legacy-cwd reads:\n")
  for (const { file, counts } of added) {
    console.error(`  + ${file}  (projection: ${counts.projection}, cwd: ${counts.cwd})`)
  }
  for (const { file, counts, recorded } of grew) {
    console.error(
      `  ↑ ${file}  (projection: ${recorded.projection}→${counts.projection}, cwd: ${recorded.cwd}→${counts.cwd})`
    )
  }
  console.error(
    "\nA surface that speaks for the whole app must read `aggregateRunState`;" +
      "\na surface bound to one conversation must key by session id" +
      "\n(`useSessionStatus(id)`, `appendMessageToSession`, `resolvePanelRoot`)." +
      "\nIf the read really is about the conversation on screen, add it with" +
      "\n`pnpm audit:workspace-attribution:baseline` and say why in the commit."
  )
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
