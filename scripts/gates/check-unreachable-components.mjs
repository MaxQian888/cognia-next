#!/usr/bin/env node
/**
 * Gate: a component that nothing renders is dead code, even when it ships a
 * test and a story.
 *
 * ## Why this is not knip's job
 *
 * knip decides reachability from its entry points, and its jest/storybook
 * plugins register `**\/*.test.tsx` and `**\/*.stories.tsx` AS entry points.
 * Working Rule 3 requires every component to ship a co-located test, and
 * Storybook adds a story next to it — so every component in this repo is
 * reachable from an entry by construction, and knip can never report one as
 * unused. The rule meant to guarantee quality structurally immunised dead UI
 * from the dead-code gate. Excluding tests from knip's `project` does not fix
 * it either: `entry` is not constrained by `project`.
 *
 * That blind spot hid 19 unreachable provider components (~215 KB of TSX),
 * including whole shipped-but-unreachable features (OpenRouter settings,
 * CLIProxyAPI settings, provider config import/export, OAuth login).
 *
 * ## What this checks
 *
 * A gated component is UNREACHABLE when no production file imports it —
 * "production" meaning any tracked `.ts`/`.tsx` that is not itself a test or a
 * story. A component whose only importers are its own `foo.test.tsx` and
 * `foo.stories.tsx` has zero users.
 *
 * This reports the ROOT of each dead cluster, not the whole cluster: if dead
 * component A imports dead component B, only A is flagged, because B does have
 * a production importer. Delete A and B surfaces on the next run. That is
 * deliberate — it keeps the output short and always actionable.
 *
 * ## Ratchet, not a cliff
 *
 * Same contract as `check-colocated-tests.mjs`: pre-existing offenders live in
 * `unreachable-component-baseline.json` and THE LIST MAY NOT GROW.
 *
 * Usage:
 *   pnpm audit:unreachable-components                     # check
 *   pnpm audit:unreachable-components -- --write-baseline # after paying debt down
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, posix } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const BASELINE_FILE = join(
  REPO_ROOT,
  "scripts",
  "gates",
  "unreachable-component-baseline.json"
)

/** Only components are gated — a dead hook or lib module is a different smell. */
export const GATED_ROOT = "components/"
/** Same carve-outs as the co-located-test rule: shadcn and vendored trees. */
export const EXCLUDED = ["components/ui/", "components/ai-elements/"]

/**
 * Test-only helpers legitimately have no production importer — that is what
 * they are for. Flagging them would train people to ignore this gate.
 * Covers `test-utils/` and `__mocks__/` directories plus the `test-*.ts`
 * filename convention (e.g. `components/interactions/test-pointer-polyfill.ts`,
 * a jsdom PointerEvent shim imported only by interaction tests).
 */
const IS_TEST_HELPER = /(^|\/)(test-utils?\/|__mocks__\/|test-[^/]*$)/

const TS_EXT = /\.(ts|tsx)$/
const IS_TEST_OR_STORY = /\.(test|spec|stories)\.[^/]+$/
const IS_DECLARATION = /\.d\.ts$/

/**
 * Build-target variants, the React Native / metro convention `next.config.ts`
 * applies to webpack via `resolve.extensions`: `foo.mobile.tsx` beside
 * `foo.tsx` is compiled INSTEAD of it for the Capacitor build. Nothing ever
 * imports the variant's own path — the importer names the default module and
 * the resolver substitutes — so the plain "who imports this file" question
 * always answers "nobody" and would flag a mounted component as dead.
 *
 * A variant is therefore reachable exactly when the module it stands in for is
 * reachable. An orphan variant (no default beside it, or a default nothing
 * renders) is still dead, and still reported.
 */
export const PLATFORM_VARIANT_TARGETS = ["mobile"]
const PLATFORM_VARIANT = new RegExp(`\\.(?:${PLATFORM_VARIANT_TARGETS.join("|")})(\\.(?:ts|tsx))$`)

/**
 * The default module a platform variant stands in for, or null when the file
 * is not a variant. Pure.
 * @param {string} file repo-relative, posix separators
 * @returns {string|null}
 */
export function platformVariantBase(file) {
  const match = PLATFORM_VARIANT.exec(file)
  if (!match) return null
  return file.slice(0, match.index) + match[1]
}

/**
 * Is this a component file whose reachability we gate? Pure.
 * @param {string} file repo-relative, posix separators
 * @returns {boolean}
 */
export function isGatedComponent(file) {
  if (!file.startsWith(GATED_ROOT)) return false
  if (EXCLUDED.some((r) => file.startsWith(r))) return false
  if (IS_TEST_HELPER.test(file)) return false
  if (!TS_EXT.test(file)) return false
  return !IS_TEST_OR_STORY.test(file) && !IS_DECLARATION.test(file)
}

/**
 * Does this file count as a production importer? Tests and stories do not —
 * that is the whole point of the gate.
 * @param {string} file
 * @returns {boolean}
 */
export function isProductionFile(file) {
  if (!TS_EXT.test(file)) return false
  return !IS_TEST_OR_STORY.test(file) && !IS_DECLARATION.test(file)
}

/**
 * Every module specifier a file imports, including dynamic `import()` and
 * `export … from`. Pure.
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const out = []
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
  let m
  while ((m = re.exec(source)) !== null) out.push(m[1])
  return out
}

/**
 * Resolve a specifier to the repo-relative file it names, or null when it is
 * external / unresolvable. Pure — the set of known files is injected.
 *
 * @param {string} spec
 * @param {string} importer repo-relative path of the importing file
 * @param {Set<string>} known every tracked repo-relative path
 * @returns {string|null}
 */
export function resolveSpecifier(spec, importer, known) {
  let base
  if (spec.startsWith("@/")) {
    base = spec.slice(2)
  } else if (spec.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(importer), spec))
  } else {
    return null // bare specifier — node_modules or a workspace package
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((c) => known.has(c)) ?? null
}

/**
 * Source with comments removed, so a doc block mentioning `export` cannot make
 * a file look like a barrel or hide a statement. Pure.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  // Line comments first. A line comment may contain `/*` (a real one in
  // `app/layout.tsx` mentions `geist/font/*`), and stripping blocks first
  // treats that as an opening delimiter and swallows everything up to the
  // next `*/`, which in that file was 140 lines away.
  return source.replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "")
}

const REEXPORT_STATEMENT =
  /export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*["'][^"']+["']\s*;?/g

/**
 * Is this file nothing but `export … from` statements?
 *
 * This is the hole the gate had. A component with no real consumer stayed
 * "reachable" because one line of `components/plugins/index.ts` re-exported
 * it, and that barrel is imported once, for a different symbol. 1020 lines of
 * dead UI passed the gate on that technicality.
 *
 * A barrel confers nothing on its own. What it re-exports is reachable only
 * when something actually asks the barrel for that name.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isPureReexportBarrel(source) {
  const bare = stripComments(source)
  if (!/export\s+(?:type\s+)?(?:\*|\{)[^]*?from/.test(bare)) return false
  const rest = bare.replace(REEXPORT_STATEMENT, "")
  return rest.trim() === ""
}

/**
 * What each name a barrel exports actually points at. Pure.
 *
 * `export { A as B } from "./x"` means an importer asking for `B` reaches
 * `./x`, and inside `./x` the name is `A` — which matters when `./x` is
 * itself a barrel.
 *
 * @param {string} source
 * @returns {{ named: Map<string, {spec: string, local: string}>, wildcards: string[] }}
 */
export function parseBarrelReexports(source) {
  const bare = stripComments(source)
  const named = new Map()
  const wildcards = []

  const wildcardRe = /export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*["']([^"']+)["']/g
  let m
  while ((m = wildcardRe.exec(bare)) !== null) wildcards.push(m[2])

  const namedRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  while ((m = namedRe.exec(bare)) !== null) {
    const spec = m[2]
    for (const raw of m[1].split(",")) {
      const clause = raw.trim().replace(/^type\s+/, "")
      if (!clause) continue
      const parts = clause.split(/\s+as\s+/)
      const local = parts[0].trim()
      const exported = (parts[1] ?? parts[0]).trim()
      if (exported) named.set(exported, { spec, local })
    }
  }
  return { named, wildcards }
}

/** Marker for an import whose names cannot be enumerated (`* as X`, or bare). */
export const ALL_BINDINGS = "*"

/**
 * Which names each specifier is imported for. Pure.
 *
 * A namespace import or a side-effect import yields {@link ALL_BINDINGS},
 * because the file could touch anything the module exports.
 *
 * @param {string} source
 * @returns {Map<string, Set<string>>} specifier → imported names
 */
export function extractImportBindings(source) {
  // Deliberately NOT comment-stripped, matching `extractImportSpecifiers`.
  // A specifier inside a comment can only make a target look reachable, which
  // is the safe direction and keeps this identical to the behaviour the
  // baseline was recorded against.
  const bare = source
  /** @type {Map<string, Set<string>>} */
  const out = new Map()
  const add = (spec, name) => {
    if (!out.has(spec)) out.set(spec, new Set())
    out.get(spec).add(name)
  }

  const importRe = /import\s+(?:(type\s+)?([^"';]*?)\s+from\s*)?["']([^"']+)["']/g
  let m
  while ((m = importRe.exec(bare)) !== null) {
    const clause = (m[2] ?? "").trim()
    const spec = m[3]
    if (!clause) {
      add(spec, ALL_BINDINGS)
      continue
    }
    if (/^\*/.test(clause) || /\*\s+as\s+/.test(clause)) {
      add(spec, ALL_BINDINGS)
      continue
    }
    const braced = /\{([^}]*)\}/.exec(clause)
    const beforeBrace = clause.split("{")[0].replace(/,\s*$/, "").trim()
    if (beforeBrace) add(spec, "default")
    if (braced) {
      for (const raw of braced[1].split(",")) {
        const c = raw.trim().replace(/^type\s+/, "")
        if (!c) continue
        add(spec, c.split(/\s+as\s+/)[0].trim())
      }
    } else if (!beforeBrace) {
      add(spec, ALL_BINDINGS)
    }
  }

  // `export … from` in a non-barrel re-exports too, and `import()` / `require()`
  // name no bindings, so both are conservative.
  const otherRe =
    /(?:\bexport\s[^;]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
  while ((m = otherRe.exec(bare)) !== null) add(m[1], ALL_BINDINGS)

  return out
}

/**
 * Compute the unreachable-component list. Pure — I/O is injected.
 *
 * @param {string[]} files every tracked repo-relative path
 * @param {{ read: (p: string) => string }} io
 * @returns {string[]} sorted unreachable component paths
 */
export function findUnreachable(files, io) {
  const known = new Set(files)
  const importedByProduction = new Set()

  const production = files.filter(isProductionFile)
  const sources = new Map(production.map((f) => [f, io.read(f)]))
  const barrels = new Map()
  for (const file of production) {
    const source = sources.get(file)
    if (isPureReexportBarrel(source)) barrels.set(file, parseBarrelReexports(source))
  }

  /**
   * Names each barrel has been asked for. A barrel enters the walk only when a
   * real consumer imports something from it, and then only the names actually
   * imported travel onwards.
   * @type {Map<string, Set<string>>}
   */
  const barrelDemand = new Map()
  const queue = []
  const demand = (barrel, name) => {
    let names = barrelDemand.get(barrel)
    if (!names) {
      names = new Set()
      barrelDemand.set(barrel, names)
    }
    if (names.has(name)) return
    names.add(name)
    queue.push({ barrel, name })
  }

  for (const file of production) {
    if (barrels.has(file)) continue // handled by demand, below
    for (const [spec, names] of extractImportBindings(sources.get(file))) {
      const target = resolveSpecifier(spec, file, known)
      if (!target || target === file) continue
      // A barrel with a real consumer is itself reachable. What it does NOT
      // do is pass that reachability to everything it re-exports: only the
      // names actually asked for travel onwards.
      importedByProduction.add(target)
      if (barrels.has(target)) {
        for (const name of names) demand(target, name)
      }
    }
  }

  while (queue.length > 0) {
    const { barrel, name } = queue.pop()
    const { named, wildcards } = barrels.get(barrel)
    // A namespace or side-effect import could touch anything the barrel
    // re-exports, so it pulls everything through.
    const entries =
      name === ALL_BINDINGS ? [...named.values()] : named.has(name) ? [named.get(name)] : []
    // `export * from` loses the name, so any demand on the barrel reaches it.
    const specs = [
      ...entries.map((e) => ({ spec: e.spec, local: e.local })),
      ...wildcards.map((spec) => ({ spec, local: ALL_BINDINGS })),
    ]
    for (const { spec, local } of specs) {
      const target = resolveSpecifier(spec, barrel, known)
      if (!target || target === barrel) continue
      importedByProduction.add(target)
      if (barrels.has(target)) demand(target, local)
    }
  }

  // A barrel nothing imports is itself a dead root. Report just the barrel and
  // let its members surface on the next run once it is deleted, which is the
  // same root-of-a-dead-cluster rule that already applies to a dead component
  // importing another. Only a REACHABLE barrel withholds reachability, which
  // is the case this gate exists to catch.
  for (const [barrel, { named, wildcards }] of barrels) {
    if (importedByProduction.has(barrel)) continue
    const specs = [...[...named.values()].map((e) => e.spec), ...wildcards]
    for (const spec of specs) {
      const target = resolveSpecifier(spec, barrel, known)
      if (target && target !== barrel) importedByProduction.add(target)
    }
  }

  return files
    .filter((f) => {
      if (!isGatedComponent(f)) return false
      if (importedByProduction.has(f)) return false
      // Build-target variants are reached through the module they replace.
      const base = platformVariantBase(f)
      return !(base && known.has(base) && importedByProduction.has(base))
    })
    .sort()
}

/**
 * Ratchet comparison. Pure.
 * @param {string[]} current
 * @param {string[]} baseline
 * @param {Set<string>} [knownFiles]
 * @returns {{ added: string[], fixed: string[], stale: string[] }}
 */
export function diffAgainstBaseline(current, baseline, knownFiles) {
  const baseSet = new Set(baseline)
  const curSet = new Set(current)
  const added = current.filter((f) => !baseSet.has(f)).sort()
  const fixed = baseline.filter((f) => !curSet.has(f) && (!knownFiles || knownFiles.has(f))).sort()
  const stale = knownFiles ? baseline.filter((f) => !knownFiles.has(f)).sort() : []
  return { added, fixed, stale }
}

/** Drop index entries deleted in the working tree but not staged yet. */
export function filterExistingFiles(files, exists) {
  return files.filter(exists)
}

/** @returns {string[]} */
function listTrackedFiles() {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64e6,
  })
    .split("\n")
    .filter(Boolean)
  return filterExistingFiles(tracked, (file) => existsSync(join(REPO_ROOT, file)))
}

/** @returns {{ version: number, files: string[] }} */
export function readBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { version: 1, files: [] }
  return JSON.parse(readFileSync(file, "utf8"))
}

export function writeBaseline(violations, file = BASELINE_FILE) {
  const payload = {
    version: 1,
    note:
      "Components with zero production importers. This list may only shrink: " +
      "`pnpm audit:unreachable-components` fails when a new one appears. Either " +
      "mount the component or delete it (with its test and story). Regenerate with " +
      "`pnpm audit:unreachable-components -- --write-baseline`, which is only " +
      "legitimate when the gate's own definition changes, not to admit a new " +
      "offender. It last grew when the gate learned that a pure re-export barrel " +
      "confers no reachability, which exposed components nothing had ever asked " +
      "the barrel for.",
    files: [...violations].sort(),
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

export function main(argv = []) {
  const files = listTrackedFiles()
  const known = new Set(files)
  const io = {
    read: (p) => {
      try {
        return readFileSync(join(REPO_ROOT, p), "utf8")
      } catch {
        return ""
      }
    },
  }

  const violations = findUnreachable(files, io)

  if (argv.includes("--write-baseline")) {
    const payload = writeBaseline(violations)
    console.log(`[unreachable-components] baseline written: ${payload.files.length} known`)
    return 0
  }

  const baseline = readBaseline()
  const { added, fixed, stale } = diffAgainstBaseline(violations, baseline.files ?? [], known)

  if (fixed.length) {
    console.log(
      `[unreachable-components] ${fixed.length} baselined component(s) are now mounted or gone — ` +
        "run `pnpm audit:unreachable-components -- --write-baseline` to lock the gain in."
    )
  }
  if (stale.length) {
    console.log(
      `[unreachable-components] ${stale.length} baseline row(s) point at files that no longer ` +
        "exist — regenerate the baseline when convenient."
    )
  }

  if (added.length) {
    console.error(
      `[unreachable-components] ${added.length} component(s) have no production importer — ` +
        "nothing renders them:"
    )
    for (const f of added) console.error(`  ${f}`)
    console.error(
      "\n  A co-located test and a story do NOT count as users; that is exactly the\n" +
        "  blind spot this gate exists to close. Either mount the component where it\n" +
        "  belongs, or delete it along with its .test.tsx and .stories.tsx."
    )
    return 1
  }

  console.log(
    `[unreachable-components] OK: ${violations.length} known, none new ` +
      `(baseline holds ${(baseline.files ?? []).length}).`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-unreachable-components.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
