/**
 * Static enforcement for every host path that renders plugin-supplied React
 * content. The inventory is intentionally explicit: adding or relocating a
 * host is a contract change and must update this list.
 *
 * Two things are checked per host, and the second is the one that has teeth:
 *
 *  1. **Surface count** — how many `<PluginSurface>` render paths the file has.
 *     A cheap inventory tripwire: it notices a surface being deleted or a new
 *     branch appearing, but on its own it proves nothing about *what* those
 *     surfaces wrap. A file could wrap an unrelated branch and render the
 *     plugin bare next to it and still count correctly.
 *
 *  2. **Plugin-node wrapping** — each host declares the JSX tags through which
 *     plugin-supplied content actually reaches the DOM (`pluginNodes`), and
 *     every occurrence of those tags must resolve to a surface. That is what
 *     makes "any call site left unwrapped ⇒ FAIL" true rather than aspirational.
 *
 * An occurrence resolves to a surface when either:
 *
 *   - a `<PluginSurface>` (or a host-local wrapper listed in `surfaceWrappers`)
 *     is a JSX ancestor of it, or
 *   - it is assigned to a local binding that is rendered as `{binding}` inside
 *     such an element somewhere in the same file. Several hosts build the
 *     plugin element into a `content` / `rendererContent` local first because
 *     the surrounding chrome differs per branch; that indirection is legitimate
 *     and the check follows it one hop.
 *
 * The one-hop rule is deliberately permissive about a binding that ALSO reaches
 * a non-surface branch — `context-workbench` renders the same local through a
 * `PanelErrorBoundary` for native (non-plugin) panels, discriminated at runtime
 * by `panel.pluginId`. No static rule can separate those two branches, so the
 * gate settles for "this value does reach a surface" and leaves the
 * discrimination to the type of `panel`.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

export interface PluginSurfaceHost {
  /** Expected number of `<PluginSurface>` render paths in the file. */
  surfaces: number
  /**
   * JSX tags through which plugin-supplied content reaches the DOM. Every
   * occurrence must resolve to a surface, and every listed tag must still occur
   * — otherwise renaming a local would silently empty the check.
   *
   * Empty is a legitimate answer: a host whose surface wraps plugin *data* it
   * renders itself (a label, an icon) has no plugin-authored component to wrap.
   */
  pluginNodes: string[]
  /** Host-local components that are themselves `PluginSurface` wrappers. */
  surfaceWrappers?: string[]
}

export const PLUGIN_SURFACE_HOSTS: Record<string, PluginSurfaceHost> = {
  "components/plugins/plugin-extension-slot.tsx": { surfaces: 1, pluginNodes: ["Cmp"] },
  // Inline and overflow branches are independent render paths.
  "components/plugins/plugin-extension-slot-with-overflow.tsx": {
    surfaces: 2,
    pluginNodes: ["ext.component"],
  },
  "components/context-workbench/context-workbench.tsx": {
    surfaces: 1,
    pluginNodes: ["Renderer"],
    surfaceWrappers: ["PluginContextPanelSurface"],
  },
  "components/plugins/plugin-context-panel-webview.tsx": {
    surfaces: 1,
    pluginNodes: ["PluginWebviewHost"],
  },
  "components/plugins/dialogs/plugin-modal-root.tsx": { surfaces: 1, pluginNodes: ["Component"] },
  "components/plugins/plugin-view-host.tsx": {
    surfaces: 1,
    pluginNodes: ["PluginCustomViewHost", "PluginTreeViewHost", "PluginWebviewHost"],
  },
  "components/shell/plugin-view-container-panel.tsx": {
    surfaces: 1,
    pluginNodes: ["PluginViewHost"],
  },
  "components/chat/message-renderer.tsx": { surfaces: 1, pluginNodes: ["PluginRenderer"] },
  "components/chat/message-parts/mcp-tool-card.tsx": { surfaces: 1, pluginNodes: ["PluginCard"] },
  // The surface wraps a label this host renders from registry data; the plugin
  // contributes no component here.
  "components/chat/composer/plugin-quick-actions-menu.tsx": { surfaces: 1, pluginNodes: [] },
  "components/plugins/detail/plugin-config-form.tsx": { surfaces: 1, pluginNodes: ["Component"] },
}

export interface PluginSurfaceAuditReport {
  ok: boolean
  errors: string[]
  hosts: Array<{ file: string; pluginSurfaceCount: number; pluginNodeCount: number }>
}

const SURFACE_TAG = "PluginSurface"

function jsxName(node: ts.JsxOpeningLikeElement): string | undefined {
  const tag = node.tagName
  if (ts.isIdentifier(tag)) return tag.text
  // `<ext.component />` — the whole dotted path is the identity we declare.
  if (ts.isPropertyAccessExpression(tag)) return tag.getText()
  return undefined
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) return node.openingElement
  if (ts.isJsxSelfClosingElement(node)) return node
  return undefined
}

/** Walk `node`'s JSX ancestors looking for a surface element. */
function hasSurfaceAncestor(node: ts.Node, surfaceTags: ReadonlySet<string>): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isJsxElement(cur)) continue
    const name = jsxName(cur.openingElement)
    if (name && surfaceTags.has(name)) return true
  }
  return false
}

/**
 * Names of local bindings that a surface renders as `{binding}` — the one hop
 * of indirection the wrapping check follows.
 */
function collectSurfaceBoundIdentifiers(
  source: ts.SourceFile,
  surfaceTags: ReadonlySet<string>
): Set<string> {
  const bound = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression)) {
      if (hasSurfaceAncestor(node, surfaceTags)) bound.add(node.expression.text)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return bound
}

/** The local this expression is being stored into, if any. */
function enclosingBindingName(node: ts.Node): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text
    if (
      ts.isBinaryExpression(cur) &&
      cur.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(cur.left)
    ) {
      return cur.left.text
    }
    // A function boundary means we left the expression being stored.
    if (ts.isFunctionLike(cur)) return undefined
  }
  return undefined
}

export function auditPluginSurfaces(repoRoot: string): PluginSurfaceAuditReport {
  const errors: string[] = []
  const hosts: PluginSurfaceAuditReport["hosts"] = []

  for (const [relativeFile, host] of Object.entries(PLUGIN_SURFACE_HOSTS)) {
    const filePath = path.join(repoRoot, relativeFile)
    if (!fs.existsSync(filePath)) {
      errors.push(`[host-missing] ${relativeFile}`)
      hosts.push({ file: relativeFile, pluginSurfaceCount: 0, pluginNodeCount: 0 })
      continue
    }

    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    )
    const surfaceTags = new Set<string>([SURFACE_TAG, ...(host.surfaceWrappers ?? [])])
    const declaredNodes = new Set(host.pluginNodes)
    const boundToSurface = collectSurfaceBoundIdentifiers(source, surfaceTags)

    let pluginSurfaceCount = 0
    let pluginNodeCount = 0
    const seenNodes = new Set<string>()
    const localBoundaries: string[] = []

    const visit = (node: ts.Node): void => {
      const opening = openingOf(node)
      const name = opening ? jsxName(opening) : undefined
      if (name === SURFACE_TAG) pluginSurfaceCount += 1
      if (name && declaredNodes.has(name)) {
        pluginNodeCount += 1
        seenNodes.add(name)
        const wrapped =
          hasSurfaceAncestor(node, surfaceTags) ||
          // The element is built into a local that a surface renders.
          ((n) => n !== undefined && boundToSurface.has(n))(enclosingBindingName(node))
        if (!wrapped) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          errors.push(
            `[unwrapped-plugin-node] ${relativeFile}:${line + 1} renders <${name}> outside <PluginSurface>`
          )
        }
      }
      if (
        ts.isClassDeclaration(node) &&
        node.name &&
        /(?:Plugin.*(?:Error)?Boundary|PluginExtensionBoundary|PluginPartErrorBoundary)/.test(
          node.name.text
        )
      ) {
        localBoundaries.push(node.name.text)
      }
      node.forEachChild(visit)
    }
    visit(source)

    hosts.push({ file: relativeFile, pluginSurfaceCount, pluginNodeCount })
    if (pluginSurfaceCount !== host.surfaces) {
      errors.push(
        `[surface-count] ${relativeFile} renders ${pluginSurfaceCount} <PluginSurface> node(s); expected ${host.surfaces}`
      )
    }
    for (const declared of declaredNodes) {
      if (!seenNodes.has(declared)) {
        errors.push(
          `[stale-plugin-node] ${relativeFile} declares <${declared}> as a plugin render site but no longer renders it`
        )
      }
    }
    for (const name of localBoundaries) {
      errors.push(
        `[shadow-boundary] ${relativeFile} defines ${name}; plugin failures belong to PluginSurface`
      )
    }
  }

  return { ok: errors.length === 0, errors, hosts }
}

/**
 * CLI body: writes the report and returns the process exit code rather than
 * calling `process.exit` itself, so the flag handling and the exit contract are
 * testable without a subprocess.
 */
export function runCli(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd()
): number {
  const report = auditPluginSurfaces(cwd)
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Plugin surface audit: ${report.ok ? "PASS" : "FAIL"} — ${report.hosts.length} host file(s), ${report.errors.length} error(s)\n`
    )
    for (const error of report.errors) process.stdout.write(`- ${error}\n`)
  }
  return report.ok ? 0 : 1
}

if (require.main === module) process.exit(runCli())
