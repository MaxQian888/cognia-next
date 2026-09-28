#!/usr/bin/env node
/**
 * Gate: ADR-0148 — panel surfaces go through `<Surface>`, and radius/elevation
 * go through the token scale.
 *
 * Two things this repo kept regrowing, both reported by users as "the app looks
 * disjointed" and "the wallpaper barely shows":
 *
 *  1. **Bare panel containers.** A `div` carrying a radius, a border AND a
 *     background is a panel. Written by hand it picks its own corner, its own
 *     tone and its own padding, and — because it is invisible to the
 *     layer-semantic system — stays fully opaque over a wallpaper while the
 *     shadcn primitive beside it goes translucent. There were 1,060 of these
 *     when the gate landed.
 *
 *  2. **Radius and shadow values no setting can reach.** `rounded-2xl`,
 *     `rounded-3xl` and arbitrary `rounded-[…]` resolve from Tailwind's static
 *     scale, not from `--radius`; `shadow-*` bypasses the `[data-elevation]`
 *     ramp. Both survive a style pack untouched, which is exactly what made
 *     "no rounded corners" impossible to actually deliver.
 *
 * ## Ratchet, not a cliff
 *
 * The existing population is recorded in `surface-baseline.json` and the gate
 * enforces the only property that matters going forward: THE LIST MAY NOT GROW.
 * Paths are stored with a per-file count, so paying one down in a file does not
 * buy room for a new one elsewhere.
 *
 * Usage:
 *   pnpm audit:surfaces                     # check
 *   pnpm audit:surfaces -- --write-baseline # after paying debt down
 */

import ts from "typescript"

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "surface-baseline.json")

/** Roots that render product chrome. */
const ROOTS = ["components", "app", "plugins"]

/**
 * `components/ui/` is shadcn's own copy and `components/ai-elements/` is
 * vendored — both are re-installed from upstream, so gating their source would
 * fail on code this repo does not author. They reach the tier system through
 * `Surface` where it matters (Card, Alert) and through the wallpaper-aware
 * `data-slot` rules otherwise.
 */
const EXCLUDED_DIRS = ["components/ui/", "components/ai-elements/"]

const EXCLUDED_FILE = /\.(test|stories)\.(ts|tsx)$/

/** Radius steps that do not track `--radius`, and the elevation bypass. */
const UNTRACKED_RADIUS = /\brounded-(?:2xl|3xl|4xl)\b|\brounded-\[(?!inherit\])[^\]]+\]/g
const RAW_SHADOW = /\bshadow-(xs|sm|md|lg|xl|2xl|inner)\b/g

/**
 * A class string that carries a radius, a border and a background is a panel.
 * Order-independent, because the three can appear in any sequence.
 */
function isBarePanel(cls) {
  const hasRadius = /\brounded-[a-z0-9[\]-]+/.test(cls)
  const hasBorder = /\bborder(\b|-[a-z])/.test(cls)
  const hasBg = /\bbg-[a-z]/.test(cls)
  return hasRadius && hasBorder && hasBg
}

function listFiles() {
  // `--others --exclude-standard` alongside `--cached`: a gate meant to catch
  // NEW code that only sees committed files is exactly backwards — a violation
  // would pass until the commit introducing it had already landed.
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      ...ROOTS.map((r) => `${r}/**/*.tsx`),
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  )
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !EXCLUDED_DIRS.some((d) => p.startsWith(d)))
    .filter((p) => !EXCLUDED_FILE.test(p))
}

/**
 * Strip comments before scanning. Documenting the very pattern this gate
 * refuses — quoting `shadow-sm` in a docstring to explain why it is refused —
 * must not itself trip the gate.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** Resolve only local constants; parameters and mutable bindings still shadow them. */
function classBindings(tree) {
  const scopes = new WeakMap()
  const root = { parent: null, functionScope: true, bindings: new Map() }
  function bind(name, scope, initializer = null) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, initializer)
    else
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) bind(element.name, scope)
      }
  }
  function index(node, parentScope) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bind(node.name, parentScope)
    }
    const isFunction = ts.isFunctionLike(node)
    const scope =
      isFunction ||
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
        ? { parent: parentScope, functionScope: isFunction, bindings: new Map() }
        : parentScope
    scopes.set(node, scope)
    if (isFunction && node.name && ts.isIdentifier(node.name)) bind(node.name, scope)
    if (ts.isParameter(node)) bind(node.name, scope)
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      const isList = ts.isVariableDeclarationList(list)
      let owner = scope
      if (isList && !(list.flags & ts.NodeFlags.BlockScoped)) {
        while (!owner.functionScope && owner.parent) owner = owner.parent
      }
      bind(node.name, owner, isList && list.flags & ts.NodeFlags.Const ? node.initializer : null)
    }
    if (ts.isImportClause(node) && node.name) bind(node.name, scope)
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name, scope)
    ts.forEachChild(node, (child) => index(child, scope))
  }
  index(tree, root)
  return (identifier) => {
    for (let scope = scopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text)
    }
    return null
  }
}

function hasVisiblePanelBorder(classes) {
  if (!/\bborder-0\b/.test(classes)) return true
  // A responsive/state variant can restore the width removed at the base.
  // A colour utility (border-red-500) alone cannot do that.
  return classes
    .split(/\s+/)
    .some((token) => /(?:^|:)border(?:-[xytrblse])?(?:-(?:[1-9]\d*|\[[^\]]+\]))?$/.test(token))
}

/** Count violations per file. Exported for the test beside this script. */
export function scanSource(rawSrc) {
  const src = stripComments(rawSrc)
  let barePanels = 0
  const tree = ts.createSourceFile(
    "surface.tsx",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const resolveClassBinding = classBindings(tree)
  const containers = new Set(["div", "section", "aside", "article", "header", "footer", "main"])
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree)
      const parentElement = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent
      const adopted =
        ts.isJsxElement(parentElement) &&
        parentElement.openingElement.tagName.getText(tree) === "Surface" &&
        parentElement.openingElement.attributes.properties.some(
          (entry) =>
            ts.isJsxAttribute(entry) &&
            entry.name.getText(tree) === "asChild" &&
            (!entry.initializer || entry.initializer.getText(tree) === "{true}")
        )
      if (containers.has(tag) && !adopted) {
        const attribute = node.attributes.properties.find(
          (entry) => ts.isJsxAttribute(entry) && entry.name.getText(tree) === "className"
        )
        if (attribute?.initializer) {
          const seen = new Set()
          function classes(value) {
            if (!value || seen.has(value)) return
            seen.add(value)
            if (ts.isIdentifier(value)) {
              classes(resolveClassBinding(value))
            } else if (ts.isStringLiteral(value) || ts.isTemplateLiteralToken(value)) {
              if (isBarePanel(value.text) && hasVisiblePanelBorder(value.text)) barePanels++
            } else if (ts.isPropertyAccessExpression(value)) {
              // Follow only the selected own property of a local object constant.
              // Scanning the whole object would count unrelated class presets.
              let object = value.expression
              const aliases = new Set()
              while (object && !aliases.has(object)) {
                aliases.add(object)
                if (ts.isIdentifier(object)) object = resolveClassBinding(object)
                else if (
                  ts.isAsExpression(object) ||
                  ts.isSatisfiesExpression(object) ||
                  ts.isParenthesizedExpression(object) ||
                  ts.isTypeAssertionExpression(object)
                ) {
                  object = object.expression
                } else break
              }
              if (object && ts.isObjectLiteralExpression(object)) {
                const property = object.properties.find(
                  (entry) =>
                    ts.isPropertyAssignment(entry) &&
                    (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
                    entry.name.text === value.name.text
                )
                if (property) classes(property.initializer)
              }
            } else if (!ts.isFunctionLike(value)) ts.forEachChild(value, classes)
          }
          classes(attribute.initializer)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const untrackedRadius = (src.match(UNTRACKED_RADIUS) ?? []).length
  const rawShadow = (src.match(RAW_SHADOW) ?? []).length
  return barePanels + untrackedRadius + rawShadow
}

export function scanRepo(files = listFiles()) {
  /** @type {Record<string, number>} */
  const found = {}
  for (const file of files) {
    const abs = join(REPO_ROOT, file)
    if (!existsSync(abs)) continue
    const n = scanSource(readFileSync(abs, "utf8"))
    if (n > 0) found[file] = n
  }
  return found
}

export function compare(found, baseline) {
  /** @type {string[]} */ const regressions = []
  /** @type {string[]} */ const improvements = []
  for (const [file, count] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) {
      regressions.push(
        allowed === 0
          ? `${file}: ${count} bare panel / untracked radius / raw shadow (new file)`
          : `${file}: ${count} (baseline allows ${allowed})`
      )
    } else if (count < allowed) {
      improvements.push(`${file}: ${count} (was ${allowed})`)
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in found)) improvements.push(`${file}: 0 (was ${baseline[file]})`)
  }
  return { regressions, improvements }
}

function main() {
  const write = process.argv.includes("--write-baseline")
  const found = scanRepo()

  if (write) {
    const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n")
    const total = Object.values(sorted).reduce((a, b) => a + b, 0)
    console.log(`wrote baseline: ${Object.keys(sorted).length} files, ${total} occurrences`)
    return
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`missing ${relative(REPO_ROOT, BASELINE_FILE)} — run with --write-baseline`)
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  const { regressions, improvements } = compare(found, baseline)

  if (improvements.length > 0) {
    console.log(`surface debt paid down in ${improvements.length} file(s) — run:`)
    console.log("  pnpm audit:surfaces -- --write-baseline")
  }
  if (regressions.length === 0) {
    const total = Object.values(found).reduce((a, b) => a + b, 0)
    console.log(`OK — ${total} known occurrences, none new`)
    return
  }
  console.error(
    `\n${regressions.length} new bare panel(s) / untracked radius / raw shadow (ADR-0148):\n`
  )
  for (const line of regressions) console.error(`  ${line}`)
  console.error(
    "\nUse <Surface layer=… radius=…> from components/surface/surface.tsx for panel\n" +
      "containers, the named radius scale (rounded-control|panel|stage|pill) for\n" +
      "corners, and elevation={0..3} for depth — a style pack cannot reach\n" +
      "rounded-2xl / rounded-[…] / shadow-*.\n"
  )
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith("check-surface-usage.mjs")) main()
