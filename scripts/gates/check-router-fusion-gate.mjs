#!/usr/bin/env node
/**
 * Router + Fusion opt-in boundary gate (ADR-0188 D36/D37).
 *
 * Router + Fusion is off by default, and "off" must mean the existing code runs
 * with none of the new code evaluated. That holds only while shared modules —
 * the send path, the chat event handler, routing fallback, durable replay, the
 * gateway and the sidecar bridge — reach Router + Fusion exclusively through:
 *
 *   - `@/lib/router-fusion/gate/*`            the gate, breaker and seams, and
 *   - `@cognia/router-fusion/settings/switches` the zero-import on/off leaf,
 *
 * and load everything else with a dynamic `import()` behind the gate. One
 * static import of the engine package or of a host module (`lib/router-fusion/
 * chat`, `db`, `host`, …) from such a module would put the ledger, the schemas
 * and the fusion database code on every user's send path.
 *
 * Rules, for runtime imports (`import … from`, `export … from`, side-effect
 * `import "…"`, `require("…")`). Type-only imports and dynamic `import()` are
 * erased or deferred, so they are fine anywhere.
 *
 *   1. Outside `lib/router-fusion/` and `packages/router-fusion/`: no runtime
 *      import of `@cognia/router-fusion` (other than `settings/switches`) or of
 *      `lib/router-fusion/` (other than `gate/`), unless the file is in
 *      ALLOWED_OUTSIDE with a reason.
 *   2. Inside `lib/router-fusion/gate/`: the same — the gate is loaded on the
 *      off path, so it may not pull the rest in either.
 *
 * Tests, stories and declaration files are exempt.
 *
 * Usage: pnpm audit:router-fusion-gate
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")

export const SCAN_ROOTS = [
  "lib",
  "hooks",
  "components",
  "stores",
  "app",
  "packages",
  "sidecar",
  "cli/src",
]

const SOURCE_FILE = /\.(ts|tsx|mts|js|mjs|cjs)$/
const EXEMPT_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.stories\.tsx?$|\.d\.ts$/

/**
 * Files outside Router + Fusion that may import it statically. Each one must be
 * off every send, gateway and sidecar path; the reason says why it is.
 */
export const ALLOWED_OUTSIDE = {
  "components/settings/provider/routing/router-fusion-section.tsx":
    "The settings section edits Router + Fusion settings; it renders only inside the routing settings pane, never on a send path.",
  "components/settings/provider/routing/router-fusion-action-catalog.tsx":
    "The action catalog editor is part of the Router + Fusion settings section and renders only inside the routing settings pane.",
  "components/settings/provider/routing/router-fusion-usd-field.tsx":
    "A dollar input of the Router + Fusion settings section (it validates with the package's microusd parser); settings pane only.",
}

const IMPORT_RE =
  /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g

/** What a module specifier points at, from the point of view of this gate. */
export function classifySpecifier(specifier, fromRel) {
  let target = specifier
  if (specifier.startsWith("@/")) target = specifier.slice(2)
  else if (specifier.startsWith("."))
    target = posix.normalize(posix.join(posix.dirname(fromRel), specifier))
  else if (
    specifier === "@cognia/router-fusion" ||
    specifier.startsWith("@cognia/router-fusion/")
  ) {
    const sub = specifier.slice("@cognia/router-fusion".length).replace(/^\//, "")
    return sub === "settings/switches" ? "switches" : "engine"
  } else return "other"

  if (
    target === "packages/router-fusion/src/settings/switches" ||
    target.startsWith("packages/router-fusion/src/settings/switches.")
  ) {
    return "switches"
  }
  if (target === "packages/router-fusion" || target.startsWith("packages/router-fusion/"))
    return "engine"
  if (target.startsWith("lib/router-fusion/gate/")) return "gate"
  if (target === "lib/router-fusion" || target.startsWith("lib/router-fusion/")) return "host"
  return "other"
}

/** Runtime (non-type) module specifiers of one source file. */
export function runtimeSpecifiers(source) {
  const out = []
  for (const match of source.matchAll(IMPORT_RE)) {
    const [, keyword, typeOnly, specifier] = match
    if (typeOnly) continue
    // `import { type A, type B } from` is erased when every binding is a type.
    const clause = match[0]
    const braces = clause.match(/\{([^}]*)\}/)
    const beforeBraces = clause.slice(0, braces?.index ?? clause.length)
    const hasDefaultOrNamespace =
      /(import|export)\s+(?:[\w$]+|\*\s+as\s+[\w$]+|\*)\s*(,|from)/.test(beforeBraces)
    if (braces && !hasDefaultOrNamespace) {
      const names = braces[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) continue
    }
    if (keyword === "export" && !/\bfrom\b/.test(clause)) continue
    out.push(specifier)
  }
  for (const match of source.matchAll(REQUIRE_RE)) out.push(match[1])
  return out
}

function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "target" || entry.startsWith("."))
      continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_FILE.test(entry) && !EXEMPT_FILE.test(entry)) out.push(full)
  }
}

/** Every boundary violation under `root`, as `{ file, specifier, kind }`. */
export function collectViolations(root = ROOT) {
  const files = []
  for (const scanRoot of SCAN_ROOTS) walk(join(root, scanRoot), files)
  const violations = []
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/")
    const inGate = rel.startsWith("lib/router-fusion/gate/")
    const inside =
      !inGate && (rel.startsWith("lib/router-fusion/") || rel.startsWith("packages/router-fusion/"))
    if (inside) continue
    if (!inGate && ALLOWED_OUTSIDE[rel]) continue
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const kind = classifySpecifier(specifier, rel)
      if (kind === "engine" || kind === "host") violations.push({ file: rel, specifier, kind })
    }
  }
  return violations
}

/** Allowlisted files that no longer exist are stale rows, not permissions. */
export function staleAllowlist(root = ROOT) {
  return Object.keys(ALLOWED_OUTSIDE).filter((rel) => !existsSync(join(root, rel)))
}

function main() {
  const violations = collectViolations()
  const stale = staleAllowlist()
  if (stale.length > 0) {
    console.error("[router-fusion-gate] allowlisted files that no longer exist:")
    for (const rel of stale) console.error(`  ${rel}`)
  }
  if (violations.length === 0 && stale.length === 0) {
    console.log(
      "[router-fusion-gate] OK: shared modules reach Router + Fusion only through its gate."
    )
    return
  }
  if (violations.length > 0) {
    console.error("[router-fusion-gate] static imports that put Router + Fusion on the off path:")
    for (const v of violations) {
      console.error(
        `  ${v.file}: "${v.specifier}" (${v.kind === "engine" ? "engine package" : "host module"})`
      )
    }
    console.error(
      "Import `@/lib/router-fusion/gate/*` or `@cognia/router-fusion/settings/switches` instead, and load the rest with `loadRouterFusionHost()`."
    )
  }
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
