/**
 * Static audit for plugin extension-point slot mounts.
 *
 * Cross-references every `CanonicalExtensionPoint` declared in
 * `lib/plugin/contracts/plugin-points.ts` against actual
 * `<PluginExtensionSlot point="..." />` / `<PluginExtensionSlotWithOverflow
 * point="..." />` JSX usages in the codebase.
 *
 * Severity by contract stability:
 *   implemented  → must have ≥1 mount, else FAIL
 *   experimental → may have 0 mounts, WARN
 *   deprecated   → unmounted is OK; mounted emits WARN
 *
 * Drift: each implemented contract's `binding` field must match at least one
 * discovered mount file path. Otherwise FAIL with `binding-drift`.
 *
 * Slot must use a string-literal `point` attribute. Computed values
 * (`point={getPoint()}`) are rejected so the audit stays sound.
 *
 * Usage:
 *   pnpm audit:slots          # exit 0 if green, 1 if red
 *   pnpm audit:slots --json   # machine-readable JSON to stdout
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"
import {
  CANONICAL_EXTENSION_POINTS,
  getExtensionPointContract,
  type CanonicalExtensionPoint,
  type PluginPointContract,
} from "../../lib/plugin/contracts/plugin-points"

const SLOT_HOST_COMPONENTS = new Set(["PluginExtensionSlot", "PluginExtensionSlotWithOverflow"])

const SCAN_ROOTS = ["app", "components", "lib"]
const SKIP_DIRS = new Set(["node_modules", "out", ".next", ".source", "scripts"])
const SKIP_FILE_PATTERNS = [/\.test\.(ts|tsx)$/, /\.spec\.(ts|tsx)$/]
const SKIP_RELATIVE_PATHS = [
  // The contract is the source-of-truth registry; it must not count as a host.
  path.normalize("lib/plugin/contracts/plugin-points.ts"),
  path.normalize("lib/plugin/contracts/extension-point-consumers.md"),
]

interface DiscoveredMount {
  point: string
  filePath: string
  line: number
  column: number
  componentName: string
}

interface ComputedAttribute {
  filePath: string
  line: number
  column: number
  componentName: string
}

interface AuditEntry {
  point: CanonicalExtensionPoint
  status: "implemented" | "deprecated" | "virtual"
  stability: "stable" | "experimental" | "deprecated"
  /**
   * How the host surfaces the slot. `jsx-mount` (the default) means the
   * audit must find at least one `<PluginExtensionSlot point="…" />` JSX
   * mount when `status === "implemented"`. `registration` means the host
   * registers contributions through a bridge function rather than a JSX
   * mount — the audit verifies the binding file exists on disk instead.
   */
  hostKind: "jsx-mount" | "registration"
  binding: string
  mounts: DiscoveredMount[]
  /** Drift errors: contract.binding doesn't match any discovered mount file. */
  drift: string | null
  /** Set when a registration-host's binding file is missing on disk. */
  registrationBindingMissing: boolean
}

interface AuditReport {
  ok: boolean
  entries: AuditEntry[]
  computedAttributeErrors: ComputedAttribute[]
  unknownPointMounts: DiscoveredMount[]
  errors: string[]
  warnings: string[]
}

function shouldSkipFile(absPath: string, repoRoot: string): boolean {
  const rel = path.relative(repoRoot, absPath)
  if (SKIP_RELATIVE_PATHS.includes(path.normalize(rel))) return true
  for (const pattern of SKIP_FILE_PATTERNS) {
    if (pattern.test(rel)) return true
  }
  return false
}

function* walkSourceFiles(rootDir: string, repoRoot: string): Generator<string> {
  if (!fs.existsSync(rootDir)) return
  const stack: string[] = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const absPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(absPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue
      if (shouldSkipFile(absPath, repoRoot)) continue
      yield absPath
    }
  }
}

function getJsxOpeningElementName(node: ts.JsxOpeningLikeElement): string | null {
  const name = node.tagName
  if (ts.isIdentifier(name)) return name.text
  if (ts.isPropertyAccessExpression(name)) return name.name.text
  return null
}

function findPointAttribute(
  node: ts.JsxOpeningLikeElement
): { kind: "literal"; value: string } | { kind: "computed" } | null {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue
    if (attr.name.getText() !== "point") continue
    const initializer = attr.initializer
    if (!initializer) return { kind: "computed" }
    if (ts.isStringLiteral(initializer)) {
      return { kind: "literal", value: initializer.text }
    }
    if (ts.isJsxExpression(initializer)) {
      const expr = initializer.expression
      if (expr && ts.isStringLiteral(expr)) {
        return { kind: "literal", value: expr.text }
      }
      if (expr && ts.isNoSubstitutionTemplateLiteral(expr)) {
        return { kind: "literal", value: expr.text }
      }
      return { kind: "computed" }
    }
    return { kind: "computed" }
  }
  return null
}

function scanFile(
  filePath: string,
  mounts: DiscoveredMount[],
  computed: ComputedAttribute[]
): void {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf-8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX
  )

  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = getJsxOpeningElementName(node)
      if (name && SLOT_HOST_COMPONENTS.has(name)) {
        const attr = findPointAttribute(node)
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
        if (!attr) {
          // No `point` attribute at all — caller programming error.
          computed.push({
            filePath,
            line: line + 1,
            column: character + 1,
            componentName: name,
          })
        } else if (attr.kind === "computed") {
          computed.push({
            filePath,
            line: line + 1,
            column: character + 1,
            componentName: name,
          })
        } else {
          mounts.push({
            point: attr.value,
            filePath,
            line: line + 1,
            column: character + 1,
            componentName: name,
          })
        }
      }
    }
    node.forEachChild(visit)
  }

  visit(source)
}

interface AuditDeps {
  repoRoot: string
  scanRoots?: readonly string[]
  canonicalPoints?: readonly string[]
  getContract?: (point: string) => PluginPointContract | undefined
}

export function evaluateAuditFromSources(
  mounts: DiscoveredMount[],
  computed: ComputedAttribute[],
  deps: Pick<AuditDeps, "repoRoot" | "canonicalPoints" | "getContract">
): AuditReport {
  const repoRoot = deps.repoRoot
  const canonicalPoints = deps.canonicalPoints ?? (CANONICAL_EXTENSION_POINTS as readonly string[])
  const getContract: (point: string) => PluginPointContract | undefined =
    deps.getContract ??
    ((point: string) =>
      canonicalPoints.includes(point)
        ? getExtensionPointContract(point as CanonicalExtensionPoint)
        : undefined)

  const mountsByPoint = new Map<string, DiscoveredMount[]>()
  for (const m of mounts) {
    const list = mountsByPoint.get(m.point) ?? []
    list.push(m)
    mountsByPoint.set(m.point, list)
  }

  const knownPointSet = new Set<string>(canonicalPoints)
  const unknownMounts = mounts.filter((m) => !knownPointSet.has(m.point))

  const entries: AuditEntry[] = canonicalPoints.map((point) => {
    const contract = getContract(point)
    if (!contract) {
      return {
        point: point as CanonicalExtensionPoint,
        status: "deprecated" as const,
        stability: "deprecated" as const,
        hostKind: "jsx-mount" as const,
        binding: "(no contract)",
        mounts: mountsByPoint.get(point) ?? [],
        drift: null,
        registrationBindingMissing: false,
      }
    }
    const pointMounts = mountsByPoint.get(point) ?? []
    const hostKind: "jsx-mount" | "registration" = contract.hostKind ?? "jsx-mount"
    let drift: string | null = null
    let registrationBindingMissing = false

    if (contract.status === "implemented" && hostKind === "jsx-mount" && pointMounts.length > 0) {
      const bindingPath = path.normalize(contract.binding).replace(/\\/g, "/")
      const matched = pointMounts.some((m) => {
        const rel = path.relative(repoRoot, m.filePath).replace(/\\/g, "/")
        return rel === bindingPath || rel.endsWith("/" + bindingPath)
      })
      if (!matched) {
        const mountPaths = pointMounts
          .map((m) => path.relative(repoRoot, m.filePath).replace(/\\/g, "/"))
          .join(", ")
        drift = `contract claims binding "${contract.binding}" but mounts found at: ${mountPaths}`
      }
    }

    if (contract.status === "implemented" && hostKind === "registration") {
      const absBinding = path.join(repoRoot, contract.binding)
      registrationBindingMissing = !fs.existsSync(absBinding)
    }

    return {
      point: point as CanonicalExtensionPoint,
      status: contract.status as "implemented" | "deprecated" | "virtual",
      stability: contract.stability,
      hostKind,
      binding: contract.binding,
      mounts: pointMounts,
      drift,
      registrationBindingMissing,
    }
  })

  const errors: string[] = []
  const warnings: string[] = []

  for (const entry of entries) {
    if (entry.status === "implemented") {
      if (entry.hostKind === "registration") {
        if (entry.registrationBindingMissing) {
          errors.push(
            `[registration-host-missing] "${entry.point}" is a registration-host slot but its binding file "${entry.binding}" was not found on disk.`
          )
        }
      } else if (entry.mounts.length === 0) {
        errors.push(
          `[implemented-unmounted] "${entry.point}" is implemented but no <PluginExtensionSlot point="${entry.point}" /> mount was found in the codebase.`
        )
      } else if (entry.drift) {
        errors.push(`[binding-drift] "${entry.point}": ${entry.drift}`)
      }
    } else if (entry.status === "virtual") {
      if (entry.mounts.length === 0) {
        warnings.push(
          `[experimental-unmounted] "${entry.point}" is virtual/experimental and has no host mount.`
        )
      }
    } else if (entry.status === "deprecated") {
      if (entry.mounts.length > 0) {
        const at = entry.mounts
          .map((m) => `${path.relative(repoRoot, m.filePath).replace(/\\/g, "/")}:${m.line}`)
          .join(", ")
        warnings.push(
          `[deprecated-mounted] "${entry.point}" is deprecated but is mounted at: ${at}`
        )
      }
    }
  }

  for (const c of computed) {
    const rel = path.relative(repoRoot, c.filePath).replace(/\\/g, "/")
    errors.push(
      `[computed-point] ${c.componentName} at ${rel}:${c.line}:${c.column} uses a computed or missing \`point\` attribute. Slots must declare \`point="…"\` as a string literal.`
    )
  }

  for (const u of unknownMounts) {
    const rel = path.relative(repoRoot, u.filePath).replace(/\\/g, "/")
    errors.push(
      `[unknown-point] ${u.componentName} at ${rel}:${u.line}:${u.column} mounts unknown point "${u.point}" — not declared in CANONICAL_EXTENSION_POINTS.`
    )
  }

  return {
    ok: errors.length === 0,
    entries,
    computedAttributeErrors: computed,
    unknownPointMounts: unknownMounts,
    errors,
    warnings,
  }
}

function buildReport(deps: AuditDeps): AuditReport {
  const mounts: DiscoveredMount[] = []
  const computed: ComputedAttribute[] = []

  const roots = deps.scanRoots ?? SCAN_ROOTS
  for (const root of roots) {
    const absRoot = path.join(deps.repoRoot, root)
    for (const file of walkSourceFiles(absRoot, deps.repoRoot)) {
      scanFile(file, mounts, computed)
    }
  }

  return evaluateAuditFromSources(mounts, computed, deps)
}

function renderMarkdown(report: AuditReport, repoRoot: string): string {
  const lines: string[] = []
  lines.push("# Plugin Extension-Slot Audit")
  lines.push("")
  lines.push(
    `Result: ${report.ok ? "PASS" : "FAIL"} — ${report.errors.length} error(s), ${report.warnings.length} warning(s)`
  )
  lines.push("")

  const groups: Record<string, AuditEntry[]> = {
    implemented: [],
    deprecated: [],
    virtual: [],
  }
  for (const e of report.entries) groups[e.status].push(e)

  for (const status of ["implemented", "virtual", "deprecated"] as const) {
    const list = groups[status]
    if (list.length === 0) continue
    lines.push(`## ${status} (${list.length})`)
    lines.push("")
    lines.push("| Point | Mounts | Binding |")
    lines.push("|---|---|---|")
    for (const e of list) {
      const mountCount = e.mounts.length
      const isRegistration = status === "implemented" && e.hostKind === "registration"
      const mark = isRegistration
        ? e.registrationBindingMissing
          ? "✗"
          : "R"
        : status === "implemented"
          ? mountCount > 0
            ? "✓"
            : "✗"
          : status === "deprecated"
            ? mountCount > 0
              ? "⚠"
              : "—"
            : mountCount > 0
              ? "✓"
              : "⚠"
      const mountList = isRegistration
        ? e.registrationBindingMissing
          ? `registration: binding missing (${e.binding})`
          : `registration: ${e.binding}`
        : e.mounts.length === 0
          ? "—"
          : e.mounts
              .map((m) => `${path.relative(repoRoot, m.filePath).replace(/\\/g, "/")}:${m.line}`)
              .join(", ")
      lines.push(`| \`${e.point}\` | ${mark} ${mountCount} (${mountList}) | \`${e.binding}\` |`)
    }
    lines.push("")
  }

  if (report.errors.length > 0) {
    lines.push("## Errors")
    lines.push("")
    for (const err of report.errors) lines.push(`- ${err}`)
    lines.push("")
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings")
    lines.push("")
    for (const w of report.warnings) lines.push(`- ${w}`)
    lines.push("")
  }

  return lines.join("\n")
}

export function runAudit(deps: AuditDeps | string): AuditReport {
  if (typeof deps === "string") return buildReport({ repoRoot: deps })
  return buildReport(deps)
}

export type { AuditReport, AuditEntry, DiscoveredMount, ComputedAttribute, AuditDeps }

function main(): void {
  const repoRoot = process.cwd()
  const wantJson = process.argv.includes("--json")
  const report = runAudit({ repoRoot })
  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else {
    process.stdout.write(renderMarkdown(report, repoRoot) + "\n")
  }
  process.exit(report.ok ? 0 : 1)
}

if (require.main === module) {
  main()
}
