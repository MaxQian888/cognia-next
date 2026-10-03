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
 * `1.91.0` (`SHIM_VSCODE_API_VERSION` in
 * `sidecar/vscode-ext-host/src/vscode-shim/index.ts`). Refusing on that range
 * would be wrong in both directions:
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

import coverage from "./vscode-api-coverage.generated.json"

/**
 * The VS Code version the shim reports as `vscode.version`.
 *
 * Not a guess: it is the sidecar shim's `SHIM_VSCODE_API_VERSION`
 * (`sidecar/vscode-ext-host/src/vscode-shim/index.ts`), the API level it
 * implements. It is valid semver because `vscode-languageclient` parses it and
 * requires `^1.91.0`. If the shim's advertised version moves, this must move
 * with it: they are the same claim made to two audiences (a test pins it).
 */
export const SHIM_VSCODE_VERSION = "1.91.0"

/**
 * What the shim provides of the API level it claims, measured by
 * `scripts/gates/check-vscode-api-coverage.mjs` against `@types/vscode` at
 * {@link SHIM_VSCODE_VERSION}: each declared value is implemented, unsupported
 * (mounted, with a reason) or missing (not mounted). The gate keeps the file
 * in step with the shim.
 */
export const VSCODE_API_COVERAGE = coverage as {
  apiVersion: string
  summary: { implemented: number; unsupported: number; missing: number }
  unsupported: Record<string, string>
  missing: string[]
  implemented: string[]
  extra: string[]
}

const isNamespace = (path: string) => /^[a-z]/.test(path) && !path.includes(".")

/**
 * Namespaces the shim mounts whose every member is unsupported (throws
 * `NotSupportedError` or registers something nothing uses). They are
 * mounted, so `vscode.debug` is defined and truthy: an extension
 * feature-detecting with `if (vscode.debug)` sees success and fails on the
 * first call. That is exactly why the warning has to reach the user at
 * install time.
 */
export const UNIMPLEMENTED_VSCODE_NAMESPACES: readonly string[] = Object.keys(
  VSCODE_API_COVERAGE.unsupported
)
  .filter(isNamespace)
  .sort()

/** Namespaces the shim implements, at least in part. Nothing branches on it. */
export const IMPLEMENTED_VSCODE_NAMESPACES: readonly string[] = [
  ...new Set(
    VSCODE_API_COVERAGE.implemented
      .filter((path) => path.includes("."))
      .map((path) => path.split(".")[0]!)
  ),
]
  .filter((namespace) => !UNIMPLEMENTED_VSCODE_NAMESPACES.includes(namespace))
  .sort()

/** Whether `name` is a namespace the shim mounts but does not implement. */
export function isUnimplementedNamespace(name: string): boolean {
  return UNIMPLEMENTED_VSCODE_NAMESPACES.includes(name)
}

const UNAVAILABLE = new Set([
  ...Object.keys(VSCODE_API_COVERAGE.unsupported),
  ...VSCODE_API_COVERAGE.missing,
])

/**
 * The API a `vscode.…` member chain reaches that Cognia does not provide, as
 * the path to report (`vscode.debug`, `vscode.window.createTreeView`), or
 * `null` when the shim provides it or the chain is not API this level
 * declares.
 */
export function unavailableVscodeApi(chain: string): string | null {
  if (!chain.startsWith("vscode.")) return null
  const [first, second] = chain.slice("vscode.".length).split(".")
  if (!first) return null
  if (isUnimplementedNamespace(first)) return `vscode.${first}`
  if (second && UNAVAILABLE.has(`${first}.${second}`)) return `vscode.${first}.${second}`
  if (!isNamespace(first) && UNAVAILABLE.has(first)) return `vscode.${first}`
  return null
}

/**
 * Why `api` (`window.createTreeView`, or a member of an unsupported namespace
 * such as `debug.startDebugging`) is unsupported, or `null` when it is not.
 */
export function unsupportedVscodeApiReason(api: string): string | null {
  const { unsupported } = VSCODE_API_COVERAGE
  return unsupported[api] ?? unsupported[api.split(".")[0]!] ?? null
}

/** Unavailable member paths (`window.createTreeView`), for the text scan. */
export const UNAVAILABLE_VSCODE_MEMBERS: readonly string[] = [...UNAVAILABLE]
  .filter((path) => path.includes(".") && !isUnimplementedNamespace(path.split(".")[0]!))
  .sort()

export type EngineCompatWarning =
  /** The bundle references API the shim does not provide (namespaces or members). */
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
   * API the bundle references that the shim does not provide (unsupported or
   * missing namespaces, members and classes), deduped and sorted. Persisted
   * onto the manifest so the warning survives the install.
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
