/**
 * Static permission inference for VS Code extensions.
 *
 * Walks the extension's main bundle with `@babel/parser` to detect
 * sensitive Node.js modules (`fs`, `child_process`, `http`, `https`,
 * `net`, `ws`), top-level `fetch()` calls, and `vscode.*` API surfaces
 * that imply cognia permissions (`secrets:*`, `authentication`,
 * `env.clipboard`). When the bundle is minified beyond the AST's
 * tolerance, falls back to string-scan heuristics and lowers the
 * `confidence` field — the sidecar's runtime `require()` interceptor
 * (Phase M3) is the authoritative gate for whatever this misses.
 *
 * The function is **pure**: no I/O, no Tauri, no filesystem.
 *
 * The output `VsCodePermissionInference` is consumed by
 * `manifest-adapter.ts:adaptVscodeManifest` and surfaced to the user
 * through the existing `lib/plugin/security/permission-guard.ts` prompt.
 *
 * The same walk also collects `unsupportedApis` — references to `vscode.*`
 * namespaces the shim mounts but doesn't implement. That output is a **UX
 * hint only** (see `engine-compat.ts`); unlike the permission set, nothing
 * gates on it, precisely because this analysis fails open.
 */

import { parse, type ParserOptions } from "@babel/parser"
import type { Node } from "@babel/types"
import { UNIMPLEMENTED_VSCODE_NAMESPACES } from "./engine-compat"
import type {
  VsCodePermissionInference,
  VsCodePermissionReason,
  VsCodeManifest,
} from "@/types/plugin/plugin-vscode"
import type { PluginPermission } from "@/types/plugin/plugin"
import type { VsixInstallResult } from "./vsix-installer"

export interface InferPermissionsInput {
  /** Output of `installVsix`. */
  vsix: VsixInstallResult
}

/**
 * Modules that imply specific cognia permissions when imported by an
 * extension bundle. Kept in one place so the AST walker, the string-scan
 * fallback, and tests all agree.
 */
const MODULE_PERMISSION_MAP: ReadonlyArray<{
  modules: ReadonlyArray<string>
  permissions: ReadonlyArray<PluginPermission>
}> = [
  {
    modules: ["fs", "fs/promises", "node:fs", "node:fs/promises", "graceful-fs"],
    permissions: ["filesystem:read", "filesystem:write"],
  },
  {
    modules: ["child_process", "node:child_process"],
    permissions: ["process:spawn", "shell:execute"],
  },
  {
    modules: ["worker_threads", "node:worker_threads"],
    permissions: ["process:spawn"],
  },
  {
    modules: ["http", "https", "node:http", "node:https", "node-fetch"],
    permissions: ["network:fetch"],
  },
  {
    modules: ["ws", "net", "tls", "node:net", "node:tls"],
    permissions: ["network:websocket", "network:fetch"],
  },
]

/**
 * Resolve the relative path of the main bundle inside the unpacked
 * `.vsix`. Mirrors the resolution rules used by `vsix-installer.ts:
 * detectBundleFormat` so the inference and bundle-format detection look
 * at the same bytes.
 */
function resolveMainBundlePath(
  pkgJson: VsCodeManifest,
  files: Map<string, Uint8Array>
): string | null {
  const main = pkgJson.main
  if (typeof main !== "string" || main.length === 0) return null
  const canon = (s: string): string =>
    s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "")
  const candidates = [
    canon(main),
    canon(`${main}.js`),
    canon(`${main}.cjs`),
    canon(`${main}.mjs`),
    canon(`${main}/index.js`),
  ]
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate
  }
  return null
}

/**
 * Heuristic confidence rating. Tuned for the realistic spectrum:
 * - "high": un-minified source, AST walk succeeded
 * - "medium": AST succeeded but bundle is large + variable names are mangled
 * - "low": AST failed entirely (we relied on string-scan)
 */
function gradeConfidence(opts: {
  parsedOk: boolean
  bundleBytes: number
  uniqueIdentifiers: number
}): VsCodePermissionInference["confidence"] {
  if (!opts.parsedOk) return "low"
  // Mangler heuristic: webpack-minified bundles typically have a very low
  // unique-identifier-to-bytes ratio (one-letter idents repeated thousands
  // of times). Threshold tuned to flag Cline-class bundles as "medium".
  if (opts.bundleBytes > 200 * 1024 && opts.uniqueIdentifiers / opts.bundleBytes < 0.005) {
    return "medium"
  }
  return "high"
}

/**
 * Run static permission inference against the parsed `.vsix`.
 *
 * Returns a deduplicated `permissions[]` list (in cognia bit order) and a
 * `reasons[]` log explaining where each permission came from.
 */
export function inferPermissions(input: InferPermissionsInput): VsCodePermissionInference {
  const { vsix } = input
  const { pkgJson, files, lspBinaryCandidates } = vsix
  const reasons: VsCodePermissionReason[] = []
  const permissions = new Set<PluginPermission>()
  /** Evidence for `engine-compat.ts`. Advisory — never gates anything. */
  const unsupportedApis = new Set<string>()
  let unparsedBundle = false
  let uniqueIdentifiers = 0
  let bundleBytes = 0
  let parsedOk = false

  // ── 1. Manifest contribution inferences (always reliable). ────────────
  const c = pkgJson.contributes
  if (c) {
    if (Array.isArray(c.authentication) && c.authentication.length > 0) {
      addPermission(
        permissions,
        reasons,
        "secrets:read",
        {
          kind: "manifest-contribution",
          contribution: "authentication",
        },
        `${c.authentication.length} authentication provider(s)`
      )
      addPermission(
        permissions,
        reasons,
        "secrets:write",
        {
          kind: "manifest-contribution",
          contribution: "authentication",
        },
        "authentication providers persist tokens in the OS keyring"
      )
      addPermission(
        permissions,
        reasons,
        "network:fetch",
        {
          kind: "manifest-contribution",
          contribution: "authentication",
        },
        "OAuth flows require network access"
      )
    }
    if (
      Array.isArray(c.mcpServerDefinitionProviders) &&
      c.mcpServerDefinitionProviders.length > 0
    ) {
      addPermission(
        permissions,
        reasons,
        "network:fetch",
        {
          kind: "manifest-contribution",
          contribution: "mcpServerDefinitionProviders",
        },
        "MCP server providers typically dial out over HTTP"
      )
    }
    if (Array.isArray(c.debuggers) && c.debuggers.length > 0) {
      // Debug adapters need to spawn the debug protocol server.
      addPermission(
        permissions,
        reasons,
        "process:spawn",
        {
          kind: "manifest-contribution",
          contribution: "debuggers",
        },
        "debug adapters spawn DAP servers"
      )
    }
    if (Array.isArray(c.taskDefinitions) && c.taskDefinitions.length > 0) {
      addPermission(
        permissions,
        reasons,
        "shell:execute",
        {
          kind: "manifest-contribution",
          contribution: "taskDefinitions",
        },
        "task providers run shell commands"
      )
    }
    if (Array.isArray(c.terminal?.profiles) && c.terminal!.profiles!.length > 0) {
      addPermission(
        permissions,
        reasons,
        "shell:execute",
        {
          kind: "manifest-contribution",
          contribution: "terminal.profiles",
        },
        "terminal profiles spawn shell processes"
      )
      addPermission(
        permissions,
        reasons,
        "process:spawn",
        {
          kind: "manifest-contribution",
          contribution: "terminal.profiles",
        },
        "terminal profiles spawn shell processes"
      )
    }
  }

  // Activation events that imply permissions even before the bundle runs.
  if (Array.isArray(pkgJson.activationEvents)) {
    if (pkgJson.activationEvents.includes("onAuthenticationRequest")) {
      addPermission(
        permissions,
        reasons,
        "secrets:read",
        {
          kind: "manifest-contribution",
          contribution: "activationEvents:onAuthenticationRequest",
        },
        "onAuthenticationRequest implies the extension answers cred requests"
      )
      addPermission(
        permissions,
        reasons,
        "secrets:write",
        {
          kind: "manifest-contribution",
          contribution: "activationEvents:onAuthenticationRequest",
        },
        "onAuthenticationRequest implies the extension writes new credentials"
      )
    }
  }

  // ── 2. LSP binary candidates always need process:spawn. ───────────────
  for (const candidate of lspBinaryCandidates) {
    addPermission(
      permissions,
      reasons,
      "process:spawn",
      {
        kind: "binary-file",
        path: candidate.path,
      },
      `${candidate.kind} detected at ${candidate.path}`
    )
    addPermission(
      permissions,
      reasons,
      "shell:execute",
      {
        kind: "binary-file",
        path: candidate.path,
      },
      `extensions shipping ${candidate.kind} typically spawn it via shell`
    )
  }

  // ── 3. Static analysis of the main bundle. ────────────────────────────
  const bundlePath = resolveMainBundlePath(pkgJson, files)
  if (!bundlePath) {
    // Theme-only or grammar-only extension — nothing to walk. There is no
    // bundle to reference an unsupported namespace from, so the empty
    // `unsupportedApis` here genuinely means "none", matching the "high".
    return {
      permissions: orderedPermissions(permissions),
      reasons,
      confidence: "high",
      unparsedBundle: false,
      unsupportedApis: [],
    }
  }
  const bundleBytesArr = files.get(bundlePath)
  if (!bundleBytesArr) {
    // Shouldn't happen — bundlePath is sourced from files map.
    return {
      permissions: orderedPermissions(permissions),
      reasons,
      confidence: "low",
      unparsedBundle: true,
      unsupportedApis: [],
    }
  }
  bundleBytes = bundleBytesArr.byteLength
  const source = new TextDecoder("utf-8", { fatal: false }).decode(bundleBytesArr)

  const ast = tryParseBundle(source)
  if (ast) {
    parsedOk = true
    const stats = walkAst(ast, permissions, reasons, unsupportedApis)
    uniqueIdentifiers = stats.uniqueIdentifiers
  } else {
    unparsedBundle = true
    scanStrings(source, permissions, reasons, unsupportedApis)
  }

  // String-scan complements the AST walk: regex catches what the AST
  // missed (e.g. `require(`fs`)` in a string-literal template) and the
  // AST walks catches what regex over-counts (string occurrences inside
  // comments). We always run both and dedupe via the permissions Set.
  scanStrings(source, permissions, reasons, unsupportedApis)

  return {
    permissions: orderedPermissions(permissions),
    reasons,
    confidence: gradeConfidence({ parsedOk, bundleBytes, uniqueIdentifiers }),
    unparsedBundle,
    unsupportedApis: [...unsupportedApis].sort(),
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function addPermission(
  set: Set<PluginPermission>,
  reasons: VsCodePermissionReason[],
  permission: PluginPermission,
  trigger: VsCodePermissionReason["trigger"],
  evidence: string
): void {
  if (!set.has(permission)) {
    set.add(permission)
  }
  reasons.push({ permission, trigger, evidence })
}

/**
 * Sort permissions by their declaration order in the cognia type so the
 * grant prompt UI surfaces a stable list across runs.
 */
function orderedPermissions(set: Set<PluginPermission>): PluginPermission[] {
  const order: PluginPermission[] = [
    "filesystem:read",
    "filesystem:write",
    "network:fetch",
    "network:websocket",
    "clipboard:read",
    "clipboard:write",
    "notification",
    "shell:execute",
    "process:spawn",
    "database:read",
    "database:write",
    "settings:read",
    "settings:write",
    "session:read",
    "session:write",
    "media:image:read",
    "media:image:write",
    "media:video:read",
    "media:video:write",
    "media:video:export",
    "agent:control",
    "python:execute",
    "sandbox:web-execute",
    "secrets:read",
    "secrets:write",
  ]
  return order.filter((p) => set.has(p))
}

function tryParseBundle(source: string): Node | null {
  // Strict parser (no errorRecovery): any syntax error → null → string-scan
  // fallback path. errorRecovery would mask genuinely broken bundles and
  // mislead the confidence rating into "high" when only the prologue was
  // valid. The runtime gate is the authoritative permission check, so
  // false-positive parser failures only cost us some static-analysis
  // reasons, never security guarantees.
  const opts: ParserOptions = {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
    plugins: ["typescript", "jsx"],
  }
  try {
    return parse(source, opts) as unknown as Node
  } catch {
    return null
  }
}

/**
 * Permission-relevant AST walk. We don't use @babel/traverse to keep the
 * dependency surface small — a hand-rolled recursive walker is enough for
 * the shapes we care about.
 */
function walkAst(
  root: Node,
  permissions: Set<PluginPermission>,
  reasons: VsCodePermissionReason[],
  unsupportedApis: Set<string>
): { uniqueIdentifiers: number } {
  const identifiers = new Set<string>()

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const n = node as Record<string, unknown> & { type?: string }

    switch (n.type) {
      case "CallExpression": {
        const callee = n.callee as Record<string, unknown> | undefined
        const args = (n.arguments as unknown[]) ?? []
        // require("xxx") / require('xxx')
        if (callee?.type === "Identifier" && callee["name"] === "require") {
          const first = args[0] as Record<string, unknown> | undefined
          if (first?.type === "StringLiteral" && typeof first["value"] === "string") {
            applyModulePermissions(first["value"], permissions, reasons, "require")
          }
        }
        // import("xxx") dynamic import
        if (callee?.type === "Import" || callee?.type === "Identifier") {
          if (callee?.["name"] === "import") {
            const first = args[0] as Record<string, unknown> | undefined
            if (first?.type === "StringLiteral" && typeof first["value"] === "string") {
              applyModulePermissions(first["value"], permissions, reasons, "import")
            }
          }
        }
        // fetch("...")
        if (callee?.type === "Identifier" && callee["name"] === "fetch") {
          addPermission(
            permissions,
            reasons,
            "network:fetch",
            {
              kind: "fetch-call",
            },
            "fetch() call detected in bundle"
          )
        }
        break
      }
      case "ImportDeclaration": {
        const sourceLit = n.source as Record<string, unknown> | undefined
        if (sourceLit?.type === "StringLiteral" && typeof sourceLit["value"] === "string") {
          applyModulePermissions(sourceLit["value"], permissions, reasons, "import")
        }
        break
      }
      case "MemberExpression": {
        // vscode.secrets.* / vscode.authentication.* / vscode.env.clipboard.*
        const root = walkMemberChain(node)
        // Unsupported-namespace evidence rides the same chain resolution.
        // Recorded, not gated: see engine-compat.ts.
        recordUnsupportedApi(root, unsupportedApis)
        if (root.startsWith("vscode.secrets")) {
          addPermission(
            permissions,
            reasons,
            "secrets:read",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.secrets API used (${root})`
          )
          addPermission(
            permissions,
            reasons,
            "secrets:write",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.secrets API used (${root})`
          )
        } else if (root.startsWith("vscode.authentication")) {
          addPermission(
            permissions,
            reasons,
            "secrets:read",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.authentication API used`
          )
          addPermission(
            permissions,
            reasons,
            "secrets:write",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.authentication API used`
          )
          addPermission(
            permissions,
            reasons,
            "network:fetch",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.authentication OAuth flows dial out`
          )
        } else if (root.startsWith("vscode.env.clipboard")) {
          addPermission(
            permissions,
            reasons,
            "clipboard:read",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.env.clipboard API used`
          )
          addPermission(
            permissions,
            reasons,
            "clipboard:write",
            {
              kind: "vscode-api",
              api: root,
            },
            `vscode.env.clipboard API used`
          )
        }
        break
      }
      case "Identifier":
        if (typeof n["name"] === "string") {
          identifiers.add(n["name"] as string)
        }
        break
    }
    for (const key in n) {
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) visit(c)
      } else if (child && typeof child === "object" && (child as { type?: string }).type) {
        visit(child)
      }
    }
  }

  visit(root)
  return { uniqueIdentifiers: identifiers.size }
}

/**
 * Resolve a MemberExpression chain like `vscode.env.clipboard.writeText`
 * into the dotted root path `vscode.env.clipboard.writeText`. Returns
 * `""` for chains that don't start at an Identifier.
 */
function walkMemberChain(node: unknown): string {
  const parts: string[] = []
  let cur: unknown = node
  while (cur && typeof cur === "object") {
    const c = cur as Record<string, unknown> & { type?: string }
    if (c.type === "MemberExpression") {
      const prop = c.property as Record<string, unknown> | undefined
      if (prop?.type === "Identifier" && typeof prop["name"] === "string") {
        parts.unshift(prop["name"] as string)
      } else {
        return ""
      }
      cur = c.object
    } else if (c.type === "Identifier" && typeof c["name"] === "string") {
      parts.unshift(c["name"] as string)
      break
    } else {
      return ""
    }
  }
  return parts.join(".")
}

/**
 * Record a `vscode.<ns>` reference when `<ns>` is one the shim doesn't
 * implement.
 *
 * Matches the namespace segment exactly rather than by prefix: `vscode.debug`
 * is unsupported, but a hypothetical `vscode.debugging` would be a different
 * API and claiming it as evidence would be a fabricated warning.
 */
function recordUnsupportedApi(chain: string, unsupportedApis: Set<string>): void {
  if (!chain.startsWith("vscode.")) return
  const namespace = chain.slice("vscode.".length).split(".")[0]
  if ((UNIMPLEMENTED_VSCODE_NAMESPACES as readonly string[]).includes(namespace)) {
    unsupportedApis.add(`vscode.${namespace}`)
  }
}

function applyModulePermissions(
  moduleName: string,
  permissions: Set<PluginPermission>,
  reasons: VsCodePermissionReason[],
  kind: "require" | "import"
): void {
  for (const entry of MODULE_PERMISSION_MAP) {
    if (entry.modules.includes(moduleName)) {
      for (const p of entry.permissions) {
        addPermission(
          permissions,
          reasons,
          p,
          { kind, module: moduleName },
          `${kind}("${moduleName}")`
        )
      }
    }
  }
}

/**
 * Regex-based fallback. Catches `require("fs")` / `from "child_process"`
 * patterns even when the AST parser fails. Intentionally permissive on
 * the source text — false positives are acceptable because the runtime
 * gate makes the authoritative decision.
 */
function scanStrings(
  source: string,
  permissions: Set<PluginPermission>,
  reasons: VsCodePermissionReason[],
  unsupportedApis: Set<string>
): void {
  // Unsupported-namespace scan. Minifiers rename locals but cannot rename
  // *property* accesses, so `vscode.debug` usually survives minification as
  // literal text — which is what makes this worth running even when the AST
  // walk succeeded. It still fails open: a bundle that aliases the namespace
  // (`const d = vscode.debug`) or builds the key dynamically defeats it, so a
  // clean scan is not evidence of absence.
  for (const namespace of UNIMPLEMENTED_VSCODE_NAMESPACES) {
    if (new RegExp(`\\bvscode\\s*\\.\\s*${namespace}\\b`).test(source)) {
      unsupportedApis.add(`vscode.${namespace}`)
    }
  }

  for (const entry of MODULE_PERMISSION_MAP) {
    for (const moduleName of entry.modules) {
      const escaped = moduleName.replace(/[/]/g, "\\/")
      const re = new RegExp(
        `(?:require\\s*\\(\\s*["'\`]${escaped}["'\`]\\s*\\)|from\\s+["'\`]${escaped}["'\`]|import\\s*\\(\\s*["'\`]${escaped}["'\`]\\s*\\))`
      )
      if (re.test(source)) {
        for (const p of entry.permissions) {
          if (!permissions.has(p)) {
            addPermission(
              permissions,
              reasons,
              p,
              { kind: "require", module: moduleName },
              `string-scan matched module "${moduleName}"`
            )
          }
        }
      }
    }
  }

  // Vscode API string-scan fallback.
  if (/\bvscode\s*\.\s*secrets\b/.test(source) && !permissions.has("secrets:read")) {
    addPermission(
      permissions,
      reasons,
      "secrets:read",
      {
        kind: "vscode-api",
        api: "vscode.secrets",
      },
      `string-scan matched vscode.secrets`
    )
    addPermission(
      permissions,
      reasons,
      "secrets:write",
      {
        kind: "vscode-api",
        api: "vscode.secrets",
      },
      `string-scan matched vscode.secrets`
    )
  }
  if (/\bvscode\s*\.\s*authentication\b/.test(source) && !permissions.has("secrets:read")) {
    addPermission(
      permissions,
      reasons,
      "secrets:read",
      {
        kind: "vscode-api",
        api: "vscode.authentication",
      },
      `string-scan matched vscode.authentication`
    )
    addPermission(
      permissions,
      reasons,
      "secrets:write",
      {
        kind: "vscode-api",
        api: "vscode.authentication",
      },
      `string-scan matched vscode.authentication`
    )
    addPermission(
      permissions,
      reasons,
      "network:fetch",
      {
        kind: "vscode-api",
        api: "vscode.authentication",
      },
      `string-scan matched vscode.authentication`
    )
  }
  if (/\bvscode\s*\.\s*env\s*\.\s*clipboard\b/.test(source) && !permissions.has("clipboard:read")) {
    addPermission(
      permissions,
      reasons,
      "clipboard:read",
      {
        kind: "vscode-api",
        api: "vscode.env.clipboard",
      },
      `string-scan matched vscode.env.clipboard`
    )
    addPermission(
      permissions,
      reasons,
      "clipboard:write",
      {
        kind: "vscode-api",
        api: "vscode.env.clipboard",
      },
      `string-scan matched vscode.env.clipboard`
    )
  }
}
