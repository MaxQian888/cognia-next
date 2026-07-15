/**
 * Will this extension actually work under cognia's VS Code shim?
 *
 * The answer is always advisory. **Nothing in this module blocks an install**,
 * and `EngineCompatReport.blocked` is typed `false` — a literal type, not a
 * boolean — so a future caller cannot start branching on it without deleting
 * that annotation and reading this comment first.
 *
 * ## Why `engines.vscode` is the wrong thing to gate on
 *
 * The obvious gate is `engines.vscode: ^1.93.0` against a shim that reports
 * `1.74.0` (`sidecar/vscode-ext-host/src/vscode-shim/index.ts` → `version:
 * "cognia-1.74.0"`). Refusing on that range would be wrong in both directions:
 *
 * - **It rejects extensions that work.** The range says which VS Code the
 *   publisher built against, never which APIs they call. Practically every
 *   maintained extension bumps it on a schedule, so the range excludes almost
 *   everything while describing almost nothing.
 * - **It admits extensions that don't.** A theme declaring `^1.40.0` passes the
 *   gate; a `^1.40.0` extension whose first act is `vscode.debug.startDebugging`
 *   also passes, and then throws `NotSupportedError` at activation.
 *
 * So the range is recorded as an *informational* warning and the real signal is
 * evidence: which namespaces the bundle actually references.
 *
 * ## The evidence, and its limits
 *
 * `permission-inference.ts` already walks the main bundle's AST, so it is
 * extended (not duplicated) to collect references to the namespaces below.
 * That inference is **best-effort and fails open**:
 *
 * - A minified bundle can defeat both the AST walk and the string scan. When
 *   `inference.unparsedBundle` is set or confidence is `"low"`, absence of a
 *   warning means *we could not tell*, never *the extension is clean*. That
 *   case emits `inference-degraded` so the UI can say so out loud.
 *   `minified_bundle_degrades_to_warning_not_block` pins it.
 * - Dynamic access (`vscode["de" + "bug"]`) is invisible to both.
 *
 * The sidecar's runtime `require()` interceptor is the authoritative gate; this
 * is a UX hint that gives the user a reason to expect breakage *before* they
 * install. **It must never be wired into a permission or security decision** —
 * a check that fails open is worthless as a control and dangerous as a
 * reassurance.
 */

import { satisfiesConstraint } from "@/lib/plugin/package/dependency-resolver"
import type { VsCodePermissionInference } from "@/types/plugin/plugin-vscode"

/**
 * The VS Code version the shim reports as `vscode.version`.
 *
 * Not a guess: it is read off the sidecar's own namespace factory
 * (`sidecar/vscode-ext-host/src/vscode-shim/index.ts:110`, `"cognia-1.74.0"`).
 * If the shim's advertised version moves, this must move with it — they are the
 * same claim made to two audiences.
 */
export const SHIM_VSCODE_VERSION = "1.74.0"

/**
 * Namespaces whose every callable throws `NotSupportedError` at runtime.
 *
 * Verified against the sidecar shim sources rather than assumed — each of these
 * modules exists and each of its methods throws:
 * `debug.ts`, `notebooks.ts`, `scm.ts`, `comments.ts`, `tests.ts`. They are
 * mounted (`index.ts` lines 98-102), so `vscode.debug` is defined and truthy;
 * an extension feature-detecting with `if (vscode.debug)` sees success and
 * fails on the first call. That is exactly why the warning has to reach the
 * user at install time.
 */
export const UNIMPLEMENTED_VSCODE_NAMESPACES = [
  "debug",
  "notebooks",
  "scm",
  "comments",
  "tests",
] as const

export type UnimplementedVsCodeNamespace = (typeof UNIMPLEMENTED_VSCODE_NAMESPACES)[number]

/**
 * Namespaces the shim implements with real behaviour. Listed for the reader's
 * benefit (and to keep the two sets visibly disjoint); nothing branches on it.
 */
export const IMPLEMENTED_VSCODE_NAMESPACES = [
  "commands",
  "window",
  "workspace",
  "languages",
  "env",
  "extensions",
  "authentication",
  "tasks",
  "lm",
  "chat",
  "terminal",
  "l10n",
] as const

/** Whether `name` is a namespace the shim mounts but does not implement. */
export function isUnimplementedNamespace(name: string): name is UnimplementedVsCodeNamespace {
  return (UNIMPLEMENTED_VSCODE_NAMESPACES as readonly string[]).includes(name)
}

export type EngineCompatWarning =
  /** The bundle references namespaces that throw at runtime. */
  | { kind: "unsupported-api"; namespaces: string[] }
  /** `engines.vscode` demands a newer VS Code than the shim reports. */
  | { kind: "engine-mismatch"; required: string; shimVersion: string }
  /** The bundle could not be read well enough to trust the absence of hits. */
  | { kind: "inference-degraded"; confidence: VsCodePermissionInference["confidence"] }

export interface EngineCompatReport {
  /**
   * Always `false`, and typed as the literal so it stays that way. Engine
   * compatibility is reported, never enforced — see the module doc.
   */
  blocked: false
  /** The raw `engines.vscode` range, or `"*"` when the manifest omitted it. */
  engineVscode: string
  /**
   * Unimplemented namespaces the bundle references, deduped and sorted.
   * Persisted onto the manifest so the warning survives the install.
   */
  unsupportedApis: string[]
  /**
   * Whether an *empty* `unsupportedApis` can be read as "uses nothing
   * unsupported". False when the bundle resisted analysis, in which case the
   * empty list means "unknown".
   */
  reliable: boolean
  warnings: EngineCompatWarning[]
}

export interface EvaluateEngineCompatInput {
  /** `engines.vscode` from the extension's `package.json`. */
  engineVscode?: string
  /** The static-analysis result from `inferPermissions`. */
  inference: Pick<VsCodePermissionInference, "unsupportedApis" | "confidence" | "unparsedBundle">
  /** Override the shim version. Tests only. */
  shimVersion?: string
}

/**
 * Assess an extension against the shim and return warnings.
 *
 * Never throws and never blocks: every failure mode of the inputs (absent
 * range, unparseable range, unreadable bundle) degrades to a warning, because
 * the alternative — refusing an extension we merely failed to understand — puts
 * the cost of our uncertainty on the user.
 */
export function evaluateEngineCompat(input: EvaluateEngineCompatInput): EngineCompatReport {
  const engineVscode =
    typeof input.engineVscode === "string" && input.engineVscode.trim().length > 0
      ? input.engineVscode.trim()
      : "*"
  const shimVersion = input.shimVersion ?? SHIM_VSCODE_VERSION
  const warnings: EngineCompatWarning[] = []

  const unsupportedApis = [...new Set(input.inference.unsupportedApis ?? [])].sort()
  if (unsupportedApis.length > 0) {
    warnings.push({ kind: "unsupported-api", namespaces: unsupportedApis })
  }

  // A bundle we couldn't read tells us nothing, and "no warning" would be read
  // as "no problem". Say which it is.
  const reliable = !input.inference.unparsedBundle && input.inference.confidence !== "low"
  if (!reliable) {
    warnings.push({ kind: "inference-degraded", confidence: input.inference.confidence })
  }

  // Informational only. An unparseable range is treated as satisfied rather
  // than as a mismatch: we would be guessing about a string we don't
  // understand, and guessing toward a scarier claim is still guessing.
  if (!satisfiesConstraint(shimVersion, engineVscode)) {
    warnings.push({ kind: "engine-mismatch", required: engineVscode, shimVersion })
  }

  return { blocked: false, engineVscode, unsupportedApis, reliable, warnings }
}
