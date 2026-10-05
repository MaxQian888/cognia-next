#!/usr/bin/env node
/**
 * Gate: the Claude sidecar keeps its layers (ADR-0197).
 *
 * The sidecar grew as a flat `dispatch/` next to a half-foldered
 * `builtin-tools/`, and the two imported each other: `dispatch → builtin-tools
 * → dispatch`, `dispatch → lsp → builtin-tools → dispatch`, and `dispatch →` a
 * process entry file used as a library. ADR-0197 moves the code, bottom-up,
 * into `sidecar/src/<layer>/` as strict TypeScript. This gate is what keeps the
 * new tree layered while the move is in flight, and after.
 *
 * ## What it checks (config: sidecar-architecture.json)
 *
 *   1. Every file under `sidecar/src/` sits in a declared layer, and imports
 *      only its own layer or the layers the config lets it import.
 *   2. Within-layer rules: a builtin tool category never imports another one;
 *      the two runtime rails never import each other.
 *   3. `src/` never imports legacy (not-yet-moved) code. Legacy may import
 *      `src/` — that is how the migration proceeds bottom-up.
 *   4. No production module imports a launcher (a process entry point), a test,
 *      or test-support.
 *   5. Every relative specifier spells its extension (Node resolves nothing
 *      else), and a relative import leaves `sidecar/` only for the declared
 *      app data files. Type-only imports count: they break the standalone
 *      `sidecar:typecheck` as surely as a runtime import breaks the bundle.
 *   6. Self-contained trees (codex-app-control, the Pi extension) and `src/`
 *      never import each other.
 *   7. Isomorphic modules (bundled into the renderer through lib/) use no
 *      Node built-ins, no packages and no `import.meta`.
 *   8. Code outside the sidecar (lib/, packages/, cli/, scripts/, tests/…)
 *      imports only the modules listed as `public`, or a launcher.
 *   9. No directory-level import cycle among production modules.
 *  10. Once `legacyMjsAllowed` is off, launchers are the only `.mjs` files.
 *  11. Vendor isolation (ADR-0217): the runtime import closure of each listed
 *      entry never reaches the listed package. Type-only imports are erased
 *      and dynamic imports load on demand, so neither counts; a static value
 *      import anywhere in the closure does. This is what keeps the host and
 *      the AI SDK engine runnable without the Claude Agent SDK. A rule with
 *      `allowedIn` also confines every reference to the package, type-only
 *      included, to those path prefixes, so the wire and the shared runtime
 *      modules type-check without it too.
 *
 * Findings are ratcheted against `sidecar-architecture-baseline.json`, the
 * violations the legacy tree had when the gate landed: a new finding fails, and
 * a fixed one must be removed from the baseline so the list only shrinks. A
 * config entry naming a file that does not exist is a hard error.
 *
 * Usage:
 *   pnpm audit:sidecar-architecture              # check
 *   pnpm audit:sidecar-architecture:baseline     # rewrite the baseline after a move
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, join, posix, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONFIG_FILE = join(REPO_ROOT, "scripts", "gates", "sidecar-architecture.json")
export const BASELINE_FILE = join(
  REPO_ROOT,
  "scripts",
  "gates",
  "sidecar-architecture-baseline.json"
)

const SOURCE_FILE = /\.(mjs|cjs|js|mts|cts|ts|tsx)$/
const DECLARATION_FILE = /\.d\.[mc]?ts$/
const TEST_FILE = /\.test\.(mjs|cjs|js|mts|cts|ts|tsx)$/
const RUNTIME_EXTENSIONS = /\.(mjs|cjs|js|mts|cts|ts|json|sql|wasm|node)$/
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".d.mts",
  "/index.ts",
  "/index.mjs",
  "/index.js",
]

/**
 * Module references in one source file, runtime and type-only alike.
 * `jest.mock("…")`-style calls count too: a test that mocks a sidecar path
 * breaks exactly like one that imports it when the path moves.
 *
 * @returns {Array<{ specifier: string, typeOnly: boolean, usesImportMeta?: never }>}
 */
export function moduleReferences(fileName, source) {
  const kind = /\.[mc]?tsx?$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind)
  const refs = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: Boolean(node.importClause?.isTypeOnly),
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      refs.push({ specifier: node.argument.literal.text, typeOnly: true })
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const callee = node.expression
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isJestPath =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "jest" &&
        ["mock", "doMock", "unmock", "requireActual", "requireMock"].includes(callee.name.text)
      if (isDynamicImport || isJestPath)
        refs.push({
          specifier: node.arguments[0].text,
          typeOnly: false,
          ...(isDynamicImport ? { dynamic: true } : {}),
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

/** A real `import.meta` expression (the AST's meta-property), not a mention in a comment. */
function usesImportMeta(fileName, source) {
  const kind = /\.[mc]?tsx?$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind)
  let found = false
  const visit = (node) => {
    if (found) return
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) found = true
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** Does the file use `import.meta`, a Node built-in, or a package? (isomorphic check) */
export function isomorphicViolations(fileName, source) {
  const problems = []
  if (usesImportMeta(fileName, source)) problems.push("import.meta")
  for (const { specifier, typeOnly } of moduleReferences(fileName, source)) {
    if (typeOnly || specifier.startsWith(".")) continue
    problems.push(isBuiltin(specifier) ? `node built-in ${specifier}` : `package ${specifier}`)
  }
  return problems
}

/** Where a repo-relative file sits in the sidecar architecture. */
export function classify(file, config) {
  if (!file.startsWith(config.scope)) return { kind: "outside" }
  if (config.nestedPackages.some((dir) => file.startsWith(dir))) return { kind: "nested" }
  if (config.generated.includes(file)) return { kind: "generated" }
  if (TEST_FILE.test(file)) return { kind: "test" }
  if (file.startsWith(config.testSupport)) return { kind: "test-support" }
  const selfContained = config.selfContained.find((dir) => file.startsWith(dir))
  // A launcher inside a self-contained tree (the codex control CLI and its
  // workers) belongs to that tree: importing its siblings is not a crossing.
  if (config.launchers.includes(file)) return { kind: "launcher", root: selfContained }
  if (selfContained) return { kind: "self-contained", root: selfContained }
  if (file.startsWith(config.sourceRoot)) {
    const layer = file.slice(config.sourceRoot.length).split("/")[0]
    return Object.hasOwn(config.layers, layer)
      ? { kind: "src", layer }
      : { kind: "src", layer: null }
  }
  return { kind: "legacy" }
}

/** Glob with a single `*` segment (`sidecar/src/tools/builtin/*\/`) → the concrete prefix `file` sits under. */
function prefixOf(pattern, file) {
  if (!pattern.includes("*")) return file.startsWith(pattern) ? pattern : null
  const [head, tail] = pattern.split("*")
  if (!file.startsWith(head)) return null
  const segment = file.slice(head.length).split("/")[0]
  const concrete = `${head}${segment}${tail}`
  return file.startsWith(concrete) ? concrete : null
}

/** Within-layer rule violations for an import between two `src/` files of the same layer. */
function withinLayerFinding(importer, target, config) {
  for (const rule of config.withinLayer) {
    const own = prefixOf(rule.from, importer)
    if (!own || target.startsWith(own)) continue
    if (rule.allow && !rule.allow.some((prefix) => target.startsWith(prefix))) {
      const sameLayerRoot =
        config.sourceRoot + importer.slice(config.sourceRoot.length).split("/")[0] + "/"
      if (target.startsWith(sameLayerRoot)) return rule.why
    }
    if (rule.deny?.some((prefix) => target.startsWith(prefix))) return rule.why
  }
  return null
}

/**
 * Tarjan SCCs over a directory graph; returns every edge whose two ends share
 * a strongly connected component, as sorted `a -> b` strings. Reporting edges
 * (not whole components) keeps the ratchet honest while cycles shrink.
 */
export function cycleEdges(edges) {
  const graph = new Map()
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, new Set())
    if (!graph.has(to)) graph.set(to, new Set())
    graph.get(from).add(to)
  }
  let index = 0
  const indices = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const component = new Map()
  const strongConnect = (v) => {
    indices.set(v, index)
    low.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)
    for (const w of graph.get(v)) {
      if (!indices.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)))
      }
    }
    if (low.get(v) === indices.get(v)) {
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        component.set(w, v)
      } while (w !== v)
    }
  }
  for (const v of graph.keys()) if (!indices.has(v)) strongConnect(v)
  const out = new Set()
  for (const [from, to] of edges) {
    if (from !== to && component.get(from) === component.get(to)) out.add(`${from} -> ${to}`)
  }
  return [...out].sort()
}

/** Resolve a relative specifier the way a reader of the tree would, trying common suffixes. */
export function resolveRelative(importer, specifier, exists) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Pure analysis over already-read sources.
 *
 * @param {object} input
 * @param {Map<string, string>} input.sidecarFiles repo-relative → source (production + tests)
 * @param {Map<string, string>} input.externalFiles repo-relative → source, files outside sidecar/ that mention it
 * @param {(rel: string) => boolean} input.exists
 * @param {any} input.config
 * @returns {{ findings: string[], hard: string[] }}
 */
export function analyze({ sidecarFiles, externalFiles, exists, config }) {
  const findings = new Set()
  const hard = []
  const dirEdges = []
  const isomorphic = new Set(config.isomorphic)

  for (const list of ["launchers", "isomorphic", "public", "externalData", "generated"]) {
    for (const file of config[list]) {
      if (list === "generated") continue
      if (!exists(file)) hard.push(`config ${list} names ${file}, which does not exist`)
    }
  }

  for (const [file, source] of sidecarFiles) {
    const where = classify(file, config)
    if (where.kind === "nested" || where.kind === "generated" || where.kind === "outside") continue
    const production = where.kind !== "test"

    if (where.kind === "src" && where.layer === null)
      findings.add(`unmapped: ${file} is under ${config.sourceRoot} but in no declared layer`)
    if (
      production &&
      !config.legacyMjsAllowed &&
      file.endsWith(".mjs") &&
      where.kind !== "launcher"
    ) {
      findings.add(`mjs: ${file} is .mjs but not a launcher`)
    }
    if (isomorphic.has(file)) {
      for (const problem of isomorphicViolations(file, source))
        findings.add(`isomorphic: ${file} uses ${problem}`)
    }

    for (const { specifier, typeOnly } of moduleReferences(file, source)) {
      if (!specifier.startsWith(".")) continue
      if (production && !RUNTIME_EXTENSIONS.test(specifier)) {
        findings.add(`extension: ${file} imports "${specifier}" without a runtime file extension`)
      }
      const target = resolveRelative(file, specifier, exists)
      if (!target) continue // the runtime/bundle guard owns unresolved imports
      if (!production) continue

      if (!target.startsWith(config.scope)) {
        if (!config.externalData.includes(target))
          findings.add(`exit: ${file} imports ${target}, outside the sidecar`)
        continue
      }
      const to = classify(target, config)
      if (to.kind === "nested" || to.kind === "generated") continue
      if (to.kind === "launcher")
        findings.add(`launcher-import: ${file} imports the process entry ${target}`)
      if (to.kind === "test" || to.kind === "test-support")
        findings.add(`test-import: ${file} imports ${target}`)

      const crossesSelfContained = (where.root || to.root) && where.root !== to.root
      if (crossesSelfContained)
        findings.add(`self-contained: ${file} imports ${target} across a self-contained boundary`)

      if (where.kind === "src" && where.layer) {
        if (to.kind === "legacy")
          findings.add(`legacy-import: ${file} imports not-yet-moved ${target}`)
        else if (to.kind === "src" && to.layer) {
          if (to.layer !== where.layer && !config.layers[where.layer].includes(to.layer)) {
            findings.add(`layer: ${file} (${where.layer}) imports ${target} (${to.layer})`)
          } else if (to.layer === where.layer) {
            const why = withinLayerFinding(file, target, config)
            if (why) findings.add(`within-layer: ${file} imports ${target} — ${why}`)
          }
        }
      }
      if (!typeOnly && to.kind !== "test" && to.kind !== "test-support") {
        dirEdges.push([posix.dirname(file), posix.dirname(target)])
      }
    }
  }

  for (const edge of cycleEdges(dirEdges)) findings.add(`cycle: ${edge}`)

  for (const rule of config.vendorIsolation ?? []) {
    for (const entry of rule.entries) {
      if (!sidecarFiles.has(entry)) {
        hard.push(`config vendorIsolation names ${entry}, which does not exist`)
        continue
      }
      for (const chain of vendorChains(entry, rule.package, sidecarFiles, exists)) {
        findings.add(`vendor: ${entry} reaches ${rule.package} at runtime: ${chain}`)
      }
    }
    if (!rule.allowedIn) continue
    for (const [file, source] of sidecarFiles) {
      const where = classify(file, config)
      if (where.kind === "nested" || where.kind === "generated" || where.kind === "outside")
        continue
      if (rule.allowedIn.some((prefix) => file.startsWith(prefix))) continue
      if (referencesPackage(file, source, rule.package)) {
        findings.add(`vendor: ${file} references ${rule.package} outside its allowed modules`)
      }
    }
  }

  const publicSet = new Set(config.public)
  for (const [file, source] of externalFiles) {
    for (const { specifier } of moduleReferences(file, source)) {
      let target = null
      if (specifier.startsWith(".")) target = resolveRelative(file, specifier, exists)
      else if (specifier.startsWith("@/"))
        target = resolveRelative("root.ts", `./${specifier.slice(2)}`, exists)
      if (!target || !target.startsWith(config.scope)) continue
      const to = classify(target, config)
      if (to.kind === "nested" || to.kind === "generated" || to.kind === "launcher") continue
      if (target.endsWith(".d.mts") || publicSet.has(target)) continue
      findings.add(`outside: ${file} imports ${target}, which is not in the public list`)
    }
  }

  return { findings: [...findings].sort(), hard }
}

/**
 * Whether one file references `pkg` (or a subpath) in any form: static,
 * type-only or dynamic. Pure.
 */
export function referencesPackage(file, source, pkg) {
  return moduleReferences(file, source).some(
    (ref) => ref.specifier === pkg || ref.specifier.startsWith(`${pkg}/`)
  )
}

/**
 * Every runtime import path from `entry` to `pkg` (a bare specifier or one of
 * its subpaths), as `a -> b -> pkg`, one per importing module. Pure.
 */
export function vendorChains(entry, pkg, sources, exists) {
  const via = new Map([[entry, null]])
  const queue = [entry]
  const chains = []
  const pathTo = (file) => {
    const steps = []
    for (let at = file; at; at = via.get(at)) steps.unshift(at)
    return steps.join(" -> ")
  }
  while (queue.length > 0) {
    const file = queue.shift()
    for (const ref of moduleReferences(file, sources.get(file) ?? "")) {
      if (ref.typeOnly || ref.dynamic) continue
      if (ref.specifier === pkg || ref.specifier.startsWith(`${pkg}/`)) {
        chains.push(`${pathTo(file)} -> ${ref.specifier}`)
        continue
      }
      if (!ref.specifier.startsWith(".")) continue
      const target = resolveRelative(file, ref.specifier, exists)
      if (target && sources.has(target) && !via.has(target)) {
        via.set(target, file)
        queue.push(target)
      }
    }
  }
  return chains
}

/** Compare current findings with the baseline. Pure. */
export function diffAgainstBaseline(current, baseline) {
  const now = new Set(current)
  const before = new Set(baseline)
  return {
    added: current.filter((finding) => !before.has(finding)),
    fixed: baseline.filter((finding) => !now.has(finding)),
  }
}

function gitFiles(args) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }
  )
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(join(REPO_ROOT, file)))
}

/** Read the sources the analysis needs from the working tree. */
export function loadInput(config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))) {
  const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8")
  const sidecarFiles = new Map()
  for (const file of gitFiles([config.scope])) {
    if (!SOURCE_FILE.test(file) || DECLARATION_FILE.test(file) || file.includes("/node_modules/"))
      continue
    if (
      config.nestedPackages.some((dir) => file.startsWith(dir)) ||
      config.generated.includes(file)
    )
      continue
    sidecarFiles.set(file, read(file))
  }
  const externalFiles = new Map()
  for (const file of gitFiles(config.externalScanRoots)) {
    if (!SOURCE_FILE.test(file) || DECLARATION_FILE.test(file) || file.includes("/node_modules/"))
      continue
    if (file.includes("/dist/")) continue
    const source = read(file)
    if (source.includes("sidecar/")) externalFiles.set(file, source)
  }
  return { sidecarFiles, externalFiles, exists: (rel) => existsSync(join(REPO_ROOT, rel)), config }
}

function main(argv) {
  const { findings, hard } = analyze(loadInput())

  if (argv.includes("--write-baseline")) {
    if (hard.length > 0) {
      for (const problem of hard) console.error(`  - ${problem}`)
      return 1
    }
    const body = {
      $comment:
        "Written by `pnpm audit:sidecar-architecture:baseline`. Rows are layering violations of the legacy sidecar tree; the list may only shrink (ADR-0197).",
      findings,
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`)
    console.log(
      `sidecar-architecture: wrote ${findings.length} baseline findings to ${relative(REPO_ROOT, BASELINE_FILE)}`
    )
    return 0
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")).findings
  const { added, fixed } = diffAgainstBaseline(findings, baseline)
  const failures = [
    ...hard,
    ...added.map((finding) => `new ${finding}`),
    ...fixed.map(
      (finding) =>
        `fixed ${finding} — remove it from the baseline (pnpm audit:sidecar-architecture:baseline)`
    ),
  ]
  if (failures.length > 0) {
    console.error(`✗ sidecar-architecture: ${failures.length} finding(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log(
    `✓ sidecar-architecture: layers hold; ${baseline.length} baselined legacy finding(s) left to fix`
  )
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
