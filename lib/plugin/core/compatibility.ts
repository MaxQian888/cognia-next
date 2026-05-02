import type { PluginManifest } from "@/types/plugin"

export type CompatibilitySeverity = "error" | "warning"

export interface CompatibilityDiagnostic {
  severity: CompatibilitySeverity
  code: string
  field: string
  message: string
  hint?: string
  expected?: string
  actual?: string
}

export interface CompatibilityRuntime {
  cogniaVersion: string
  nodeVersion?: string
  pythonVersion?: string
}

export interface CompatibilityEvaluation {
  compatible: boolean
  diagnostics: CompatibilityDiagnostic[]
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version.trim())
  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function satisfiesSimpleRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version)
  if (!parsedVersion) return false

  const normalized = range.trim()
  if (!normalized) return true

  const operators = [">=", "<=", ">", "<", "=", "^", "~"]
  const operator = operators.find((candidate) => normalized.startsWith(candidate))
  const rawTarget = operator ? normalized.slice(operator.length).trim() : normalized
  const parsedTarget = parseVersion(rawTarget)
  if (!parsedTarget) return false

  const cmp = compareVersions(parsedVersion, parsedTarget)

  switch (operator) {
    case ">=":
      return cmp >= 0
    case "<=":
      return cmp <= 0
    case ">":
      return cmp > 0
    case "<":
      return cmp < 0
    case "=":
      return cmp === 0
    case "^":
      return parsedVersion.major === parsedTarget.major && cmp >= 0
    case "~":
      return (
        parsedVersion.major === parsedTarget.major &&
        parsedVersion.minor === parsedTarget.minor &&
        cmp >= 0
      )
    default:
      return cmp === 0
  }
}

function extractMinimumVersion(range: string): ParsedVersion | null {
  const normalized = range.trim()
  if (!normalized) {
    return null
  }

  const operators = [">=", "<=", ">", "<", "=", "^", "~"]
  const operator = operators.find((candidate) => normalized.startsWith(candidate))
  const rawTarget = operator ? normalized.slice(operator.length).trim() : normalized
  return parseVersion(rawTarget)
}

function isBuiltinPlugin(manifest: PluginManifest): boolean {
  return manifest.id.startsWith("cognia-")
}

function buildBuiltinAlignmentHint(runtime: CompatibilityRuntime): string {
  return `Built-in plugins should align plugin.json \`engines.cognia\` and \`minAppVersion\` to the host baseline ${runtime.cogniaVersion}.`
}

function pushDiagnostic(
  diagnostics: CompatibilityDiagnostic[],
  diagnostic: CompatibilityDiagnostic
): void {
  diagnostics.push(diagnostic)
}

export function evaluatePluginCompatibility(
  manifest: PluginManifest,
  runtime: CompatibilityRuntime
): CompatibilityEvaluation {
  const diagnostics: CompatibilityDiagnostic[] = []
  const engines = manifest.engines || {}
  const minAppVersion = manifest.minAppVersion
  const builtinPlugin = isBuiltinPlugin(manifest)
  const parsedRuntimeVersion = parseVersion(runtime.cogniaVersion)

  if (!engines.cognia) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "compat.cognia_engine_missing",
      field: "engines.cognia",
      message: "Missing host compatibility declaration for Cognia.",
      hint: builtinPlugin
        ? `Add \`engines.cognia\` to plugin.json (example: \">=${runtime.cogniaVersion}\"). ${buildBuiltinAlignmentHint(runtime)}`
        : 'Add `engines.cognia` to plugin.json (example: ">=0.1.0").',
    })
  } else if (!satisfiesSimpleRange(runtime.cogniaVersion, engines.cognia)) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "compat.cognia_engine_mismatch",
      field: "engines.cognia",
      message: "Plugin host version is incompatible with engines.cognia requirement.",
      expected: engines.cognia,
      actual: runtime.cogniaVersion,
      hint: builtinPlugin
        ? `Upgrade Cognia host or align the built-in plugin manifest to the current host version ${runtime.cogniaVersion}. ${buildBuiltinAlignmentHint(runtime)}`
        : "Upgrade Cognia host or adjust plugin engines.cognia range.",
    })
  }

  if (minAppVersion) {
    const parsedMinAppVersion = parseVersion(minAppVersion)
    if (!parsedMinAppVersion) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "compat.min_app_version_invalid",
        field: "minAppVersion",
        message: "Plugin minAppVersion is not a valid semver value.",
        expected: "semver (for example 0.1.0)",
        actual: minAppVersion,
        hint: "Update plugin.json minAppVersion to a valid semver string.",
      })
    } else if (
      parsedRuntimeVersion &&
      compareVersions(parsedRuntimeVersion, parsedMinAppVersion) < 0
    ) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "compat.min_app_version_mismatch",
        field: "minAppVersion",
        message: "Plugin host version is below the declared minAppVersion requirement.",
        expected: minAppVersion,
        actual: runtime.cogniaVersion,
        hint: builtinPlugin
          ? `Lower minAppVersion or ship the built-in plugin with a host version at least ${minAppVersion}. ${buildBuiltinAlignmentHint(runtime)}`
          : "Upgrade Cognia host or lower plugin minAppVersion.",
      })
    }
  } else if (builtinPlugin) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "compat.builtin_min_app_version_missing",
      field: "minAppVersion",
      message: "Built-in plugin is missing minAppVersion.",
      hint: `Add \`minAppVersion\` to plugin.json and align it with \`engines.cognia\`. ${buildBuiltinAlignmentHint(runtime)}`,
    })
  }

  if (builtinPlugin && engines.cognia && minAppVersion) {
    const minimumFromEngine = extractMinimumVersion(engines.cognia)
    const parsedMinAppVersion = parseVersion(minAppVersion)
    if (
      minimumFromEngine &&
      parsedMinAppVersion &&
      compareVersions(parsedMinAppVersion, minimumFromEngine) !== 0
    ) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "compat.builtin_version_alignment_mismatch",
        field: "minAppVersion",
        message: "Built-in plugin engines.cognia minimum does not align with minAppVersion.",
        expected: engines.cognia,
        actual: minAppVersion,
        hint: `Align both fields to the same minimum supported host version. ${buildBuiltinAlignmentHint(runtime)}`,
      })
    }
  }

  if (
    engines.node &&
    runtime.nodeVersion &&
    !satisfiesSimpleRange(runtime.nodeVersion, engines.node)
  ) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "compat.node_engine_mismatch",
      field: "engines.node",
      message: "Node runtime does not satisfy engines.node requirement.",
      expected: engines.node,
      actual: runtime.nodeVersion,
      hint: "Use a compatible Node.js runtime or update plugin engines.node.",
    })
  }

  const requiresPythonRuntime = manifest.type === "python" || manifest.type === "hybrid"
  if (requiresPythonRuntime && !runtime.pythonVersion) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "compat.python_runtime_unavailable",
      field: "engines.python",
      message: "Python plugin requires python runtime information but none is available.",
      hint: "Enable Python runtime in host settings or run in an environment with Python support.",
    })
  } else if (requiresPythonRuntime && engines.python && runtime.pythonVersion) {
    if (!satisfiesSimpleRange(runtime.pythonVersion, engines.python)) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "compat.python_engine_mismatch",
        field: "engines.python",
        message: "Python runtime does not satisfy engines.python requirement.",
        expected: engines.python,
        actual: runtime.pythonVersion,
        hint: "Install a compatible Python version or update plugin engines.python range.",
      })
    }
  }

  return {
    compatible: diagnostics.every((item) => item.severity !== "error"),
    diagnostics,
  }
}
