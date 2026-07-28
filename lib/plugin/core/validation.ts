/**
 * Plugin Validation - Validates plugin manifests and configurations
 */

import type {
  PluginManifest,
  PluginConfigSchema,
  PluginConfigProperty,
  PluginCapability,
  PluginPermission,
  PluginResilienceConfig,
  PluginType,
} from "@/types/plugin"
import { icons as lucideIcons } from "lucide-react"

import { toLucideIconName } from "@/lib/icons/lucide-icon-name"
import { checkResilienceBudget, resolveResilienceConfig } from "@/lib/plugin/resilience/config"
import { loggers } from "./logger"
import {
  CANONICAL_PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_CONTRACTS,
  validatePluginCapabilities,
} from "@/lib/plugin/contracts/plugin-capabilities"
import {
  validateActivationEvent,
  validateExtensionPoint,
  type PluginPointGovernanceMode,
} from "@/lib/plugin/contracts/plugin-points"
import { isValidPluginTableName, MAX_TABLES_PER_PLUGIN } from "@/lib/plugin/dexie/namespace"
import {
  CANONICAL_CONTEXT_ACTIVITIES,
  CONTEXT_RESOURCE_READ_PERMISSIONS,
} from "@/types/context-workbench"
import { PLUGIN_MODAL_SIZES, PLUGIN_MODAL_VARIANTS } from "@/types/plugin/plugin-modal"
import { getPluginPathViolations, type PluginPathViolation } from "@/lib/plugin/core/plugin-path"
import { IdeManifestError, normalizeIdeManifest } from "@/lib/plugin/ide/manifest"
import {
  AUTHOR_CAPABILITY_CONTRACTS,
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
  PLUGIN_MANIFEST_CONTRIBUTIONS,
  PLUGIN_PATH_FIELD_CONTRACTS,
  PLUGIN_RUNTIME_ENTRY_CONTRACTS,
} from "@/packages/plugin-sdk/src/contracts/catalog"

// =============================================================================
// Types
// =============================================================================

export interface ValidationError {
  field: string
  code: string
  message: string
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function declaredMinimumHostVersion(constraint: string): string | undefined {
  return constraint.match(/\d+\.\d+\.\d+/)?.[0]
}

export interface ManifestDiagnostic extends ValidationError {
  severity: "error" | "warning"
  hint?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  diagnostics?: ManifestDiagnostic[]
}

export interface ConfigValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: string[]
}

export interface ManifestValidationOptions {
  governanceMode?: PluginPointGovernanceMode
}

// =============================================================================
// Constants
// =============================================================================

const VALID_CAPABILITIES: PluginCapability[] = [...CANONICAL_PLUGIN_CAPABILITIES]

const VALID_PERMISSIONS = [...CANONICAL_PLUGIN_PERMISSIONS] as PluginPermission[]

const VALID_PLUGIN_TYPES = [...CANONICAL_PLUGIN_TYPES] as PluginType[]

const WASM_API_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const WASM_PREOPEN_PATH_PATTERN = /^[^\0]+$/

const ID_PATTERN = /^[a-z0-9]([a-z0-9-_.]*[a-z0-9])?$/
const RESERVED_PLUGIN_IDS = new Set([".host-state", "_marketplace_cache", "_backups"])
const MAX_PLUGIN_ID_LENGTH = 128
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z0-9]+)?$/i

function isValidPluginId(id: string): boolean {
  return id.length <= MAX_PLUGIN_ID_LENGTH && ID_PATTERN.test(id) && !RESERVED_PLUGIN_IDS.has(id)
}

// Shared validators for the ADR-0026 lazy-factory manifest fields.
//
// Every new declarative provider/renderer/middleware entry uses the same
// `{ id, label, entry, export }` shape. The validators below enforce:
//   - id matches the standard ID_PATTERN (lowercase alphanumeric + sep)
//   - entry is a relative path, no traversal (`..`), no NUL bytes, no
//     absolute / drive-letter prefixes
//   - export is a non-empty JS identifier
//   - duplicate ids inside the same field reject
//
// Mirrors the path-traversal guard `lib/plugin/bridge/themes-bridge.ts`
// applies to `vscodeJsonPath`, keeping security policy consistent across
// every manifest plugin-supplied path.

const JS_IDENT_PATTERN = /^[$_a-zA-Z][$_a-zA-Z0-9]*$/

function nestedContributionValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isPlainObject(current)) return undefined
    return current[segment]
  }, value)
}

interface ContributionExecutionSplit {
  /** At least one populated entry genuinely needs a JavaScript factory. */
  requiresJavascript: boolean
  /** At least one populated entry routes to Python on an experimental capability. */
  pythonBackedExperimental: boolean
}

/**
 * The backend a contribution entry executes on, most specific first:
 *   1. an explicit per-entry `backend`;
 *   2. a declared JS module path (`entry`) — writing one *is* the declaration
 *      of JS intent, so we never silently ignore it on a python plugin;
 *   3. the plugin-type default — python plugins default their contributions to
 *      python-backed, every other type to JS.
 */
function effectiveContributionBackend(
  entry: unknown,
  contract: (typeof PLUGIN_MANIFEST_CONTRIBUTIONS)[number],
  pluginType: unknown
): string {
  if (isPlainObject(entry) && typeof entry.backend === "string") return entry.backend
  const entryField = contract.entryPath?.split(".").pop()
  if (entryField && isPlainObject(entry) && typeof entry[entryField] === "string") {
    if (entry[entryField] !== "") return "js"
  }
  return pluginType === "python" ? "python" : "js"
}

/**
 * Split a contribution's populated entries into "needs a JS factory" versus
 * "routes through the plugin_python_call seam". Keep rule-for-rule in lockstep
 * with `crates/cognia-cli/src/commands/lint/rules.rs`.
 */
function contributionExecutionSplit(
  manifest: Record<string, unknown>,
  contract: (typeof PLUGIN_MANIFEST_CONTRIBUTIONS)[number]
): ContributionExecutionSplit {
  const contribution = manifest[contract.field]
  const entries = Array.isArray(contribution)
    ? contribution
    : isPlainObject(contribution)
      ? [contribution]
      : []
  if (entries.length === 0) return { requiresJavascript: false, pythonBackedExperimental: false }

  const baseRequiresJavascript = (entry: unknown): boolean => {
    if (contract.execution === "javascript") return true
    if (contract.execution !== "conditional" || !contract.javascriptWhen) return false
    const value = nestedContributionValue(entry, contract.javascriptWhen.path)
    return contract.javascriptWhen.equals === undefined
      ? value !== undefined && value !== null && value !== ""
      : value === contract.javascriptWhen.equals
  }

  // An absent `pythonExecution` means "unsupported": the capability stays
  // JS-only (React UI, config component) whichever backend is requested.
  const pythonBackable = (contract.pythonExecution ?? "unsupported") !== "unsupported"
  let requiresJavascript = false
  let pythonBackedExperimental = false
  for (const entry of entries) {
    if (!baseRequiresJavascript(entry)) continue
    if (
      pythonBackable &&
      effectiveContributionBackend(entry, contract, manifest.type) === "python"
    ) {
      if (contract.pythonExecution === "experimental") pythonBackedExperimental = true
      continue
    }
    requiresJavascript = true
  }
  return { requiresJavascript, pythonBackedExperimental }
}

function pluginPathMessage(violation: PluginPathViolation): string {
  if (violation === "invalid_chars") return '"entry" contains unsafe or encoded path characters'
  if (violation === "absolute") return '"entry" must be a relative path'
  return '"entry" must not contain ".." path segments'
}

interface LazyFactoryEntry {
  id?: unknown
  label?: unknown
  entry?: unknown
  export?: unknown
}

interface CatalogPathValue {
  field: string
  value: unknown
}

function collectCatalogPathValues(
  value: unknown,
  segments: readonly string[],
  concreteSegments: readonly string[] = [],
  output: CatalogPathValue[] = []
): CatalogPathValue[] {
  const [segment, ...rest] = segments
  if (!segment) {
    output.push({ field: concreteSegments.join("."), value })
    return output
  }
  if (!isPlainObject(value)) return output

  const arrayField = segment.endsWith("[]") ? segment.slice(0, -2) : undefined
  if (arrayField !== undefined) {
    const entries = value[arrayField]
    if (!Array.isArray(entries)) return output
    entries.forEach((entry, index) => {
      collectCatalogPathValues(
        entry,
        rest,
        [...concreteSegments, `${arrayField}[${index}]`],
        output
      )
    })
    return output
  }

  if (Object.prototype.hasOwnProperty.call(value, segment) && value[segment] !== undefined) {
    collectCatalogPathValues(value[segment], rest, [...concreteSegments, segment], output)
  }
  return output
}

function catalogPathDiagnosticCode(field: string, contractPath: string, violation: string): string {
  const normalizedField = field.replace(/\[\d+\]/g, "")
  const violationPath = contractPath.includes(".")
    ? `${normalizedField}.${violation}`
    : `${normalizedField}.entry.${violation}`
  return `manifest.${violationPath}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface LazyFactoryFieldOptions {
  /** Manifest field name (e.g. "ocrProviders"). Drives error codes. */
  field: string
  /** Whether each entry requires a `label` field. Default true. */
  requireLabel?: boolean
  /**
   * Optional per-entry extra validation. Return diagnostics for the entry;
   * the runner attaches them to the right field path. The callback receives
   * the entry object already verified as plain object.
   */
  extra?: (
    entry: Record<string, unknown>,
    index: number,
    push: (severity: "error" | "warning", code: string, message: string) => void
  ) => void
  /**
   * When it returns true for an entry, `entry`/`export` stop being required —
   * the contribution is backed by something other than a JS module (e.g. a
   * `contextPanels[].webview` reference). The `extra` callback owns validating
   * that alternative backing.
   */
  moduleOptional?: (entry: Record<string, unknown>) => boolean
}

function validateLazyFactoryArray(
  raw: unknown,
  options: LazyFactoryFieldOptions,
  pushError: (field: string, code: string, message: string, hint?: string) => void,
  pushWarning: (field: string, code: string, message: string, hint?: string) => void,
  /** Owning plugin's `type` — decides the default contribution backend. */
  pluginType?: unknown
): void {
  const { field, requireLabel = true, extra, moduleOptional } = options
  if (raw === undefined) return

  if (!Array.isArray(raw)) {
    pushError(field, `manifest.${field}.invalid_type`, `"${field}" must be an array if provided`)
    return
  }

  const seenIds = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as LazyFactoryEntry
    const path = `${field}[${i}]`

    if (!isPlainObject(entry)) {
      pushError(path, `manifest.${field}.invalid_item`, `Entry at index ${i} must be an object`)
      continue
    }

    if (typeof entry.id !== "string" || entry.id.length === 0) {
      pushError(
        `${path}.id`,
        `manifest.${field}.id.missing`,
        `Entry at index ${i} requires a non-empty string "id"`
      )
    } else if (!ID_PATTERN.test(entry.id)) {
      pushError(
        `${path}.id`,
        `manifest.${field}.id.invalid`,
        `Entry id "${entry.id}" must be lowercase alphanumeric with hyphens/underscores/dots`
      )
    } else if (seenIds.has(entry.id)) {
      pushError(
        `${path}.id`,
        `manifest.${field}.id.duplicate`,
        `Duplicate id "${entry.id}" in "${field}"`
      )
    } else {
      seenIds.add(entry.id)
    }

    if (requireLabel && (typeof entry.label !== "string" || entry.label.length === 0)) {
      pushError(
        `${path}.label`,
        `manifest.${field}.label.missing`,
        `Entry at index ${i} requires a non-empty string "label"`
      )
    }

    // `entry`/`export` name a JS module + symbol, so they are required only
    // when this contribution actually executes in JS. A python-backed entry
    // resolves through the plugin_python_call seam and declares neither —
    // same rule as `effectiveContributionBackend` above. A contribution the
    // field's `moduleOptional` claims (e.g. a webview-backed context panel)
    // likewise has no module; its alternative backing is validated in `extra`.
    if (moduleOptional?.(entry as Record<string, unknown>)) {
      if (extra) {
        extra(entry as Record<string, unknown>, i, (severity, code, message) => {
          const fullCode = `manifest.${field}.${code}`
          if (severity === "error") {
            pushError(path, fullCode, message)
          } else {
            pushWarning(path, fullCode, message)
          }
        })
      }
      continue
    }
    const entryBackend =
      typeof entry.backend === "string"
        ? entry.backend
        : typeof entry.entry === "string" && entry.entry.length > 0
          ? "js"
          : pluginType === "python"
            ? "python"
            : "js"

    if (
      entryBackend !== "python" &&
      (typeof entry.entry !== "string" || entry.entry.length === 0)
    ) {
      pushError(
        `${path}.entry`,
        `manifest.${field}.entry.missing`,
        `Entry at index ${i} requires a non-empty string "entry" (relative path)`
      )
    }

    if (entryBackend === "python") {
      // Nothing further to check: behaviour lives in the subprocess.
    } else if (typeof entry.export !== "string" || entry.export.length === 0) {
      pushError(
        `${path}.export`,
        `manifest.${field}.export.missing`,
        `Entry at index ${i} requires a non-empty string "export" (named JS export)`
      )
    } else if (!JS_IDENT_PATTERN.test(entry.export)) {
      pushError(
        `${path}.export`,
        `manifest.${field}.export.invalid`,
        `"export" must be a valid JS identifier (got "${entry.export}")`
      )
    }

    if (extra) {
      extra(entry as Record<string, unknown>, i, (severity, code, message) => {
        const fullCode = `manifest.${field}.${code}`
        if (severity === "error") {
          pushError(path, fullCode, message)
        } else {
          pushWarning(path, fullCode, message)
        }
      })
    }
  }
}

function validateDeclarativeExtensions(
  manifest: PluginManifest,
  pushError: (field: string, code: string, message: string, hint?: string) => void
): void {
  const raw = manifest.extensions
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    pushError(
      "extensions",
      "manifest.extensions.invalid_type",
      '"extensions" must be an array if provided'
    )
    return
  }

  const declaredPermissions = new Set(manifest.permissions ?? [])
  for (let index = 0; index < raw.length; index += 1) {
    const field = `extensions[${index}]`
    const entry = raw[index] as unknown
    if (!isPlainObject(entry)) {
      pushError(field, "manifest.extensions.invalid_item", `${field} must be an object`)
      continue
    }
    if (typeof entry.point !== "string" || entry.point.length === 0) {
      pushError(
        `${field}.point`,
        "manifest.extensions.point.missing",
        `${field} requires a canonical "point"`
      )
    } else {
      const validation = validateExtensionPoint(entry.point, {
        governanceMode: "block",
        hasPermission: (permission) => declaredPermissions.has(permission as PluginPermission),
      })
      if (!validation.allowed || validation.canonicalId !== entry.point) {
        pushError(
          `${field}.point`,
          "manifest.extensions.point.invalid",
          `Unknown or unavailable canonical extension point "${entry.point}"`
        )
      }
    }
    if (typeof entry.entry !== "string" || entry.entry.length === 0) {
      pushError(
        `${field}.entry`,
        "manifest.extensions.entry.missing",
        `${field} requires a non-empty "entry"`
      )
    } else {
      for (const violation of getPluginPathViolations(entry.entry)) {
        pushError(
          `${field}.entry`,
          `manifest.extensions.entry.${violation}`,
          pluginPathMessage(violation)
        )
      }
    }
    if (typeof entry.export !== "string" || !JS_IDENT_PATTERN.test(entry.export)) {
      pushError(
        `${field}.export`,
        "manifest.extensions.export.invalid",
        `${field} requires a valid JavaScript export name`
      )
    }
    if (entry.when !== undefined && typeof entry.when !== "string") {
      pushError(
        `${field}.when`,
        "manifest.extensions.when.invalid",
        `${field}.when must be a string`
      )
    }
    for (const widthField of ["minWidth", "maxWidth"] as const) {
      const value = entry[widthField]
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      ) {
        pushError(
          `${field}.${widthField}`,
          `manifest.extensions.${widthField}.invalid`,
          `${field}.${widthField} must be a finite positive number`
        )
      }
    }
    if (
      typeof entry.minWidth === "number" &&
      typeof entry.maxWidth === "number" &&
      entry.minWidth > entry.maxWidth
    ) {
      pushError(
        field,
        "manifest.extensions.width.invalid",
        `${field}.minWidth must not exceed maxWidth`
      )
    }
  }
}

function validateDeclarativeTrayItems(
  manifest: PluginManifest,
  pushError: (field: string, code: string, message: string, hint?: string) => void
): void {
  const raw = manifest.trayItems
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    pushError(
      "trayItems",
      "manifest.trayItems.invalid_type",
      '"trayItems" must be an array if provided'
    )
    return
  }
  raw.forEach((item, index) => {
    const field = `trayItems[${index}]`
    if (!isPlainObject(item)) {
      pushError(field, "manifest.trayItems.invalid_item", `${field} must be an object`)
      return
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      pushError(`${field}.id`, "manifest.trayItems.id.missing", `${field} requires an "id"`)
    }
    if (typeof item.label !== "string" || item.label.length === 0) {
      pushError(
        `${field}.label`,
        "manifest.trayItems.label.missing",
        `${field} requires a fallback "label"`
      )
    }
    const dispatchTargets = [item.command, item.slash].filter(
      (target) => typeof target === "string" && target.length > 0
    )
    if (dispatchTargets.length !== 1) {
      pushError(
        field,
        "manifest.trayItems.dispatch.invalid",
        `${field} must declare exactly one dispatch target: "command" or "slash"`
      )
    }
    if (item.when !== undefined && typeof item.when !== "string") {
      pushError(
        `${field}.when`,
        "manifest.trayItems.when.invalid",
        `${field}.when must be a string`
      )
    }
  })
}

function validateIntegrations(
  manifest: PluginManifest,
  pushError: (field: string, code: string, message: string, hint?: string) => void
): void {
  const raw = manifest.integrations
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    pushError(
      "integrations",
      "manifest.integrations.invalid_type",
      '"integrations" must be an array if provided'
    )
    return
  }
  const integrationIds = new Set<string>()
  raw.forEach((integration, index) => {
    const field = `integrations[${index}]`
    if (!isPlainObject(integration)) {
      pushError(field, "manifest.integrations.invalid_item", `${field} must be an object`)
      return
    }
    if (typeof integration.id !== "string" || !ID_PATTERN.test(integration.id)) {
      pushError(`${field}.id`, "manifest.integrations.id.invalid", `${field}.id is invalid`)
    } else if (integrationIds.has(integration.id)) {
      pushError(`${field}.id`, "manifest.integrations.id.duplicate", `${field}.id is duplicated`)
    } else {
      integrationIds.add(integration.id)
    }
    if (typeof integration.label !== "string" || integration.label.length === 0) {
      pushError(
        `${field}.label`,
        "manifest.integrations.label.missing",
        `${field}.label is required`
      )
    }
    for (const arrayField of [
      "authStrategies",
      "resourceKinds",
      "eventTypes",
      "actions",
    ] as const) {
      if (!Array.isArray(integration[arrayField])) {
        pushError(
          `${field}.${arrayField}`,
          `manifest.integrations.${arrayField}.invalid_type`,
          `${field}.${arrayField} must be an array`
        )
      }
    }
    const authStrategyIds = new Set<string>()
    for (const [strategyIndex, strategy] of (integration.authStrategies ?? []).entries()) {
      const strategyField = `${field}.authStrategies[${strategyIndex}]`
      if (!isPlainObject(strategy)) {
        pushError(
          strategyField,
          "manifest.integrations.auth_strategy.invalid_item",
          `${strategyField} must be an object`
        )
        continue
      }
      if (typeof strategy.id !== "string" || !ID_PATTERN.test(strategy.id)) {
        pushError(
          `${strategyField}.id`,
          "manifest.integrations.auth_strategy.id.invalid",
          `${strategyField}.id is invalid`
        )
      } else if (authStrategyIds.has(strategy.id)) {
        pushError(
          `${strategyField}.id`,
          "manifest.integrations.auth_strategy.id.duplicate",
          `${strategyField}.id is duplicated`
        )
      } else {
        authStrategyIds.add(strategy.id)
      }
      if (!["oauth2", "api-key", "personal-access-token", "app"].includes(String(strategy.type))) {
        pushError(
          `${strategyField}.type`,
          "manifest.integrations.auth_strategy.type.invalid",
          `${strategyField}.type is unsupported`
        )
      }
      if (typeof strategy.label !== "string" || strategy.label.length === 0) {
        pushError(
          `${strategyField}.label`,
          "manifest.integrations.auth_strategy.label.missing",
          `${strategyField}.label is required`
        )
      }
      if (typeof strategy.providerId !== "string" || !ID_PATTERN.test(strategy.providerId)) {
        pushError(
          `${strategyField}.providerId`,
          "manifest.integrations.auth_strategy.provider.invalid",
          `${strategyField}.providerId is invalid`
        )
      }
      if (
        strategy.scopes !== undefined &&
        (!Array.isArray(strategy.scopes) ||
          strategy.scopes.some((scope) => typeof scope !== "string" || scope.length === 0))
      ) {
        pushError(
          `${strategyField}.scopes`,
          "manifest.integrations.auth_strategy.scopes.invalid",
          `${strategyField}.scopes must contain non-empty strings`
        )
      }
      if (strategy.configSchema !== undefined && !isPlainObject(strategy.configSchema)) {
        pushError(
          `${strategyField}.configSchema`,
          "manifest.integrations.auth_strategy.config_schema.invalid",
          `${strategyField}.configSchema must be a JSON Schema object`
        )
      }
      if (strategy.requestAuth !== undefined) {
        const requestAuth = strategy.requestAuth
        const validBearer = isPlainObject(requestAuth) && requestAuth.type === "bearer"
        const validHeader =
          isPlainObject(requestAuth) &&
          requestAuth.type === "header" &&
          typeof requestAuth.name === "string" &&
          /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(requestAuth.name) &&
          (requestAuth.prefix === undefined || typeof requestAuth.prefix === "string")
        if (!validBearer && !validHeader) {
          pushError(
            `${strategyField}.requestAuth`,
            "manifest.integrations.auth_strategy.request_auth.invalid",
            `${strategyField}.requestAuth must declare bearer or a valid header injection`
          )
        }
      }
    }
    const actionIds = new Set<string>()
    for (const [actionIndex, action] of (integration.actions ?? []).entries()) {
      const actionField = `${field}.actions[${actionIndex}]`
      if (!isPlainObject(action)) {
        pushError(
          actionField,
          "manifest.integrations.actions.invalid_item",
          `${actionField} must be an object`
        )
        continue
      }
      if (typeof action.id !== "string" || !ID_PATTERN.test(action.id)) {
        pushError(
          `${actionField}.id`,
          "manifest.integrations.actions.id.invalid",
          `${actionField}.id is invalid`
        )
      } else if (actionIds.has(action.id)) {
        pushError(
          `${actionField}.id`,
          "manifest.integrations.actions.id.duplicate",
          `${actionField}.id is duplicated`
        )
      } else {
        actionIds.add(action.id)
      }
      if (
        typeof action.handler !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(action.handler)
      ) {
        pushError(
          `${actionField}.handler`,
          "manifest.integrations.actions.handler.invalid",
          `${actionField}.handler must name a JavaScript export`
        )
      }
      if (!["read", "write", "destructive"].includes(String(action.risk))) {
        pushError(
          `${actionField}.risk`,
          "manifest.integrations.actions.risk.invalid",
          `${actionField}.risk must be read, write, or destructive`
        )
      }
      if (!["required", "supported", "none"].includes(String(action.idempotency))) {
        pushError(
          `${actionField}.idempotency`,
          "manifest.integrations.actions.idempotency.invalid",
          `${actionField}.idempotency must be required, supported, or none`
        )
      }
      if (!isPlainObject(action.inputSchema)) {
        pushError(
          `${actionField}.inputSchema`,
          "manifest.integrations.actions.input_schema.invalid",
          `${actionField}.inputSchema must be a JSON Schema object`
        )
      }
      if (
        action.timeoutMs !== undefined &&
        (!Number.isInteger(action.timeoutMs) || action.timeoutMs <= 0)
      ) {
        pushError(
          `${actionField}.timeoutMs`,
          "manifest.integrations.actions.timeout.invalid",
          `${actionField}.timeoutMs must be a positive integer`
        )
      }
    }
    for (const [originIndex, origin] of (integration.allowedOrigins ?? []).entries()) {
      let valid = false
      try {
        const parsed = new URL(origin)
        valid = parsed.protocol === "https:" && parsed.origin === origin
      } catch {
        valid = false
      }
      if (!valid) {
        pushError(
          `${field}.allowedOrigins[${originIndex}]`,
          "manifest.integrations.allowed_origin.invalid",
          `${field}.allowedOrigins entries must be exact HTTPS origins`
        )
      }
    }
    if (integration.ingress) {
      if (
        typeof integration.ingress.normalizer !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(integration.ingress.normalizer)
      ) {
        pushError(
          `${field}.ingress.normalizer`,
          "manifest.integrations.ingress.normalizer.invalid",
          `${field}.ingress.normalizer must name a JavaScript export`
        )
      }
      if (!isPlainObject(integration.ingress.verification)) {
        pushError(
          `${field}.ingress.verification`,
          "manifest.integrations.ingress.verification.invalid",
          `${field}.ingress.verification must be an object`
        )
      }
    }
  })
}

function validateWorkflowKindAliases(
  manifest: PluginManifest,
  pushError: (field: string, code: string, message: string, hint?: string) => void
): void {
  const aliases = manifest.workflowKindAliases
  if (aliases === undefined) return
  if (!isPlainObject(aliases)) {
    pushError(
      "workflowKindAliases",
      "manifest.workflow_kind_aliases.invalid_type",
      '"workflowKindAliases" must be an object if provided'
    )
    return
  }
  for (const [legacyKind, targetKind] of Object.entries(aliases)) {
    if (!legacyKind.trim() || typeof targetKind !== "string" || !targetKind.trim()) {
      pushError(
        `workflowKindAliases.${legacyKind}`,
        "manifest.workflow_kind_aliases.invalid_entry",
        "Workflow kind aliases require non-empty source and target kinds"
      )
      continue
    }
    if (
      targetKind !== "trigger.integration.event" &&
      !targetKind.startsWith(`${manifest.id}.action.`)
    ) {
      pushError(
        `workflowKindAliases.${legacyKind}`,
        "manifest.workflow_kind_aliases.target_outside_plugin",
        `Workflow kind alias target "${targetKind}" must belong to plugin "${manifest.id}"`
      )
    }
  }
}

const NATIVE_LUCIDE_ICON_PATHS = [
  "commands[].icon",
  "modes[].icon",
  "quickActions[].icon",
  "trayItems[].icon",
  "viewsContainers[].icon",
  "a2uiComponents[].icon",
  "a2uiTemplates[].icon",
  "petAchievements[].icon",
  "petItems[].icon",
  "workflowTemplates[].icon",
  "agentTeamTemplates[].icon",
  "sharedMemoryAdapters[].icon",
  "workflows.nodes[].iconName",
  "workflows.triggers[].iconName",
  "integrations[].icon",
] as const

/** True when the name is a key `lucide-react` actually exports. */
function isExportedLucideIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(lucideIcons, name)
}

function validateNativeLucideIcons(
  manifest: PluginManifest,
  pushError: (field: string, code: string, message: string, hint?: string) => void,
  pushWarning: (field: string, code: string, message: string, hint?: string) => void
): void {
  for (const path of NATIVE_LUCIDE_ICON_PATHS) {
    for (const { field, value } of collectCatalogPathValues(
      manifest as unknown as Record<string, unknown>,
      path.split(".")
    )) {
      if (typeof value === "string" && isExportedLucideIcon(value)) continue
      // The kebab-case spelling was the published contract until the
      // `PLUGIN_CONTEXT_PANEL_ICONS` allowlist was retired, so an already
      // installed plugin using it is following the documentation it was
      // written against. Accept it with a warning that names the replacement
      // rather than refusing to load.
      if (typeof value === "string" && isExportedLucideIcon(toLucideIconName(value))) {
        pushWarning(
          field,
          "manifest.icon.legacy_kebab_case",
          `"${field}" uses the retired kebab-case icon name "${value}"; rename it to "${toLucideIconName(value)}"`
        )
        continue
      }
      pushError(
        field,
        "manifest.icon.invalid",
        `"${field}" must name an exported lucide-react icon`
      )
    }
  }
}

// =============================================================================
// Manifest Validation
// =============================================================================

export function validatePluginManifest(
  manifest: unknown,
  options: ManifestValidationOptions = {}
): ValidationResult {
  const diagnostics: ManifestDiagnostic[] = []
  const governanceMode = options.governanceMode || "warn"

  if (!manifest || typeof manifest !== "object") {
    return {
      valid: false,
      errors: ["Manifest must be an object"],
      warnings: [],
      diagnostics: [
        {
          severity: "error",
          field: "$",
          code: "manifest.invalid_type",
          message: "Manifest must be an object",
        },
      ],
    }
  }

  const m = manifest as Record<string, unknown>
  const pushError = (field: string, code: string, message: string, hint?: string): void => {
    diagnostics.push({ severity: "error", field, code, message, hint })
  }
  const pushWarning = (field: string, code: string, message: string, hint?: string): void => {
    diagnostics.push({ severity: "warning", field, code, message, hint })
  }

  // Required fields
  if (!m.id || typeof m.id !== "string") {
    pushError("id", "manifest.id.missing", 'Missing or invalid "id" field')
  } else if (!isValidPluginId(m.id)) {
    pushError(
      "id",
      "manifest.id.invalid_format",
      `Invalid plugin ID "${m.id}". Must be 1-${MAX_PLUGIN_ID_LENGTH} lowercase alphanumeric/separator characters and must not use a host-reserved directory name`
    )
  }

  if (!m.name || typeof m.name !== "string") {
    pushError("name", "manifest.name.missing", 'Missing or invalid "name" field')
  } else if (m.name.length > 50) {
    pushWarning("name", "manifest.name.long", "Plugin name exceeds 50 characters")
  }

  if (!m.version || typeof m.version !== "string") {
    pushError("version", "manifest.version.missing", 'Missing or invalid "version" field')
  } else if (!VERSION_PATTERN.test(m.version)) {
    pushError(
      "version",
      "manifest.version.invalid_format",
      `Invalid version "${m.version}". Must be semver format (e.g., 1.0.0)`
    )
  }

  if (!m.description || typeof m.description !== "string") {
    pushError(
      "description",
      "manifest.description.missing",
      'Missing or invalid "description" field'
    )
  } else if (m.description.length > 500) {
    pushWarning(
      "description",
      "manifest.description.long",
      "Plugin description exceeds 500 characters"
    )
  }

  if (!m.type || typeof m.type !== "string") {
    pushError("type", "manifest.type.missing", 'Missing or invalid "type" field')
  } else if (!VALID_PLUGIN_TYPES.includes(m.type as PluginType)) {
    pushError(
      "type",
      "manifest.type.invalid",
      `Invalid plugin type "${m.type}". Must be one of: ${VALID_PLUGIN_TYPES.join(", ")}`
    )
  }

  if (!m.capabilities || !Array.isArray(m.capabilities)) {
    pushError(
      "capabilities",
      "manifest.capabilities.missing",
      'Missing or invalid "capabilities" field'
    )
  } else {
    const declaredCapabilities: string[] = []
    for (const cap of m.capabilities) {
      if (typeof cap === "string") {
        declaredCapabilities.push(cap)
      }
      if (!VALID_CAPABILITIES.includes(cap as PluginCapability)) {
        pushError(
          "capabilities",
          "manifest.capabilities.invalid",
          `Invalid capability "${cap}". Must be one of: ${VALID_CAPABILITIES.join(", ")}`
        )
      }
    }

    const capabilityOutcome = validatePluginCapabilities(declaredCapabilities, { governanceMode })
    for (const diagnostic of capabilityOutcome.diagnostics) {
      const code = `manifest.capabilities.${diagnostic.code}`
      if (diagnostic.severity === "error") {
        pushError("capabilities", code, diagnostic.message, diagnostic.hint)
      } else {
        pushWarning("capabilities", code, diagnostic.message, diagnostic.hint)
      }
    }

    // Cross-check declared capabilities against their contribution fields,
    // driven by `PLUGIN_CAPABILITY_CONTRACTS[].manifestFields` (the same single
    // source the contracts expose). Two non-fatal smells:
    //   - a capability declared with none of its gating fields populated, and
    //   - a contribution field populated without its gating capability tag.
    // Capabilities with no manifest field (api-only: tray/media/canvas/…) are
    // skipped. A field shared by several capabilities (e.g. `workflows`) is
    // satisfied if ANY of its capabilities is declared.
    const declaredSet = new Set(declaredCapabilities)
    const hasField = (field: string): boolean => {
      const value = (m as unknown as Record<string, unknown>)[field]
      if (Array.isArray(value)) return value.length > 0
      // `workflows` is an object block (PluginManifestWorkflowsBlock), not an
      // array contribution — it counts as populated when it carries nodes
      // and/or triggers entries.
      if (field === "workflows" && value !== null && typeof value === "object") {
        const block = value as { nodes?: unknown; triggers?: unknown }
        return (
          (Array.isArray(block.nodes) && block.nodes.length > 0) ||
          (Array.isArray(block.triggers) && block.triggers.length > 0)
        )
      }
      return false
    }
    const fieldToCapabilities = new Map<string, string[]>()
    for (const contract of PLUGIN_CAPABILITY_CONTRACTS) {
      if (contract.manifestFields.length === 0) continue
      // Skip `python`: its fields are entry points (pythonMain string /
      // pythonDependencies), validated by the type-specific block, not
      // array contributions.
      if (contract.id === "python") continue
      // declared-but-empty: capability tag present, no gating field populated.
      if (
        declaredSet.has(contract.id) &&
        !contract.manifestFieldsOptional &&
        !contract.manifestFields.some(hasField)
      ) {
        pushWarning(
          "capabilities",
          "manifest.capability.field_missing",
          `Capability "${contract.id}" is declared but its contribution field(s) ${contract.manifestFields
            .map((f) => `"${f}"`)
            .join(" / ")} are empty.`,
          "Add the contribution entries, or drop the capability tag."
        )
      }
      for (const field of contract.manifestFields) {
        const list = fieldToCapabilities.get(field) ?? []
        list.push(contract.id)
        fieldToCapabilities.set(field, list)
      }
    }
    // populated-but-undeclared: field has entries, none of its caps declared.
    for (const [field, caps] of fieldToCapabilities) {
      if (hasField(field) && !caps.some((c) => declaredSet.has(c))) {
        pushWarning(
          "capabilities",
          "manifest.capability.field_undeclared",
          `Field "${field}" has entries but none of its capabilities (${caps.join(", ")}) is declared.`,
          `Add one of: ${caps.join(", ")} to "capabilities".`
        )
      }
    }
  }

  // Runtime ownership comes from the canonical contract. Hybrid plugins always
  // own their Python entry; their JavaScript entry is conditional on declaring
  // JavaScript-executed contributions.
  const pluginType = typeof m.type === "string" ? m.type : undefined
  const runtimeEntryContract = pluginType ? PLUGIN_RUNTIME_ENTRY_CONTRACTS[pluginType] : undefined
  for (const field of runtimeEntryContract?.required ?? []) {
    if (typeof m[field] === "string" && m[field].length > 0) continue
    const messages: Record<string, [string, string]> = {
      main: [
        'Frontend plugin must have a "main" entry point',
        "Add a valid relative JS entry file path in `main`.",
      ],
      pythonMain: [
        'Python and hybrid plugins must have a "pythonMain" entry point',
        "Add a valid relative Python entry file path in `pythonMain`.",
      ],
      wasmMain: [
        'WASM plugin must have a "wasmMain" entry point',
        "Set `wasmMain` to the relative path of the compiled `.wasm` component.",
      ],
      vscodeMain: [
        'VS Code extension plugins must have a "vscodeMain" entry point',
        "Set `vscodeMain` to the adapted extension runtime entry.",
      ],
    }
    const [message, hint] = messages[field] ?? [
      `Plugin type "${pluginType}" requires a "${field}" entry point`,
      `Add a valid relative entry path in \`${field}\`.`,
    ]
    pushError(field, `manifest.${field}.required`, message, hint)
  }
  const requiredAnyOf: readonly string[] =
    runtimeEntryContract &&
    "requiredAnyOf" in runtimeEntryContract &&
    Array.isArray(runtimeEntryContract.requiredAnyOf)
      ? (runtimeEntryContract.requiredAnyOf as string[])
      : []
  if (
    requiredAnyOf.length > 0 &&
    !requiredAnyOf.some((field) => {
      const value = m[field]
      return (
        (typeof value === "string" && value.length > 0) ||
        (Array.isArray(value) && value.length > 0) ||
        (typeof value === "object" && value !== null && Object.keys(value).length > 0)
      )
    })
  ) {
    pushError(
      requiredAnyOf[0],
      "manifest.runtime_entry.required_any_of",
      `Plugin type "${pluginType}" requires at least one of: ${requiredAnyOf.join(", ")}`,
      "Add an executable entry or a supported declarative contribution."
    )
  }

  if (m.type === "wasm") {
    if (typeof m.wasmMain === "string" && !m.wasmMain.toLowerCase().endsWith(".wasm")) {
      pushError(
        "wasmMain",
        "manifest.wasmMain.invalid_extension",
        '"wasmMain" must point to a `.wasm` file'
      )
    }
    const wasmBlock = m.wasm as Record<string, unknown> | undefined
    if (!wasmBlock || typeof wasmBlock !== "object") {
      pushError(
        "wasm",
        "manifest.wasm.required",
        'WASM plugin must declare a "wasm" block with at least `apiVersion`',
        'Example: `"wasm": { "apiVersion": "0.1.0" }`.'
      )
    } else {
      if (
        typeof wasmBlock.apiVersion !== "string" ||
        !WASM_API_VERSION_PATTERN.test(wasmBlock.apiVersion)
      ) {
        pushError(
          "wasm.apiVersion",
          "manifest.wasm.apiVersion.invalid",
          'WASM `apiVersion` must be semver MAJOR.MINOR.PATCH (e.g. "0.1.0")'
        )
      }
      if (
        wasmBlock.memoryLimitMb !== undefined &&
        (typeof wasmBlock.memoryLimitMb !== "number" ||
          wasmBlock.memoryLimitMb <= 0 ||
          wasmBlock.memoryLimitMb > 4096)
      ) {
        pushError(
          "wasm.memoryLimitMb",
          "manifest.wasm.memoryLimitMb.invalid",
          "WASM `memoryLimitMb` must be a positive number ≤ 4096"
        )
      }
      if (
        wasmBlock.callTimeoutMs !== undefined &&
        (typeof wasmBlock.callTimeoutMs !== "number" ||
          wasmBlock.callTimeoutMs <= 0 ||
          wasmBlock.callTimeoutMs > 600_000)
      ) {
        pushError(
          "wasm.callTimeoutMs",
          "manifest.wasm.callTimeoutMs.invalid",
          "WASM `callTimeoutMs` must be a positive number ≤ 600000 (10 min)"
        )
      }
      const fsBlock = wasmBlock.fs as Record<string, unknown> | undefined
      if (fsBlock && Array.isArray(fsBlock.preopens)) {
        for (let i = 0; i < fsBlock.preopens.length; i++) {
          const p = fsBlock.preopens[i]
          if (typeof p !== "string" || !WASM_PREOPEN_PATH_PATTERN.test(p)) {
            pushError(
              `wasm.fs.preopens[${i}]`,
              "manifest.wasm.preopens.invalid",
              `WASM preopen path at index ${i} must be a non-empty string without NUL bytes`
            )
          }
        }
      }
    }
  }

  for (const contract of PLUGIN_PATH_FIELD_CONTRACTS) {
    const values = collectCatalogPathValues(m, contract.path.split("."))
    for (const { field, value } of values) {
      for (const violation of getPluginPathViolations(value)) {
        pushError(
          field,
          catalogPathDiagnosticCode(field, contract.path, violation),
          pluginPathMessage(violation)
        )
      }
    }
  }

  const contributionSplits = PLUGIN_MANIFEST_CONTRIBUTIONS.map((contract) => ({
    field: contract.field,
    ...contributionExecutionSplit(m, contract),
  }))
  const populatedJsContributionFields = contributionSplits
    .filter((split) => split.requiresJavascript)
    .map((split) => split.field)
  const experimentalPythonField = contributionSplits.find(
    (split) => split.pythonBackedExperimental
  )?.field
  if (experimentalPythonField) {
    pushWarning(
      experimentalPythonField,
      "manifest.contributions.python.experimental",
      `Python-backed "${experimentalPythonField}" is experimental; its subprocess execution path may change`,
      "Gate it behind a feature flag and verify end-to-end before relying on it."
    )
  }
  if (
    populatedJsContributionFields.length > 0 &&
    runtimeEntryContract &&
    runtimeEntryContract.javascriptEntry === null
  ) {
    const isPythonOnly = m.type === "python"
    pushError(
      populatedJsContributionFields[0],
      isPythonOnly
        ? "manifest.contributions.javascript.unsupported_for_python"
        : "manifest.contributions.javascript.unsupported_for_plugin_type",
      `Plugin type "${m.type}" cannot declare JavaScript-executed contributions`,
      isPythonOnly
        ? 'Change the plugin type to "hybrid" and add "main", or remove those contributions.'
        : "Use a JavaScript-capable plugin type, or remove those contributions."
    )
  } else if (
    runtimeEntryContract?.javascriptEntryRequiredForContributions &&
    populatedJsContributionFields.length > 0 &&
    runtimeEntryContract.javascriptEntry &&
    typeof m[runtimeEntryContract.javascriptEntry] !== "string"
  ) {
    pushError(
      runtimeEntryContract.javascriptEntry,
      `manifest.${runtimeEntryContract.javascriptEntry}.required_for_js_contributions`,
      `JavaScript-executed contributions require a relative "${runtimeEntryContract.javascriptEntry}" entry point`,
      `Add "${runtimeEntryContract.javascriptEntry}", or remove JavaScript-executed contributions.`
    )
  }

  // Optional fields validation
  if (m.permissions && Array.isArray(m.permissions)) {
    for (const perm of m.permissions) {
      if (!VALID_PERMISSIONS.includes(perm as PluginPermission)) {
        pushWarning(
          "permissions",
          "manifest.permissions.unknown",
          `Unknown permission "${perm}"`,
          "Use only documented permissions or ensure runtime guard supports this permission."
        )
      }
    }
  }

  // Network egress allowlist (Figma-style). Validate shape + require a public
  // `reasoning` whenever the plugin asks for any-host ("*") access, so the
  // permission-review UI can explain WHY the plugin reaches the whole internet.
  if (m.networkAccess !== undefined) {
    if (typeof m.networkAccess !== "object" || m.networkAccess === null) {
      pushError(
        "networkAccess",
        "manifest.networkAccess.invalid",
        '"networkAccess" must be an object with an "allowedDomains" array'
      )
    } else {
      const na = m.networkAccess as { allowedDomains?: unknown; reasoning?: unknown }
      if (na.allowedDomains !== undefined) {
        if (!Array.isArray(na.allowedDomains)) {
          pushError(
            "networkAccess.allowedDomains",
            "manifest.networkAccess.allowedDomains.invalid",
            '"networkAccess.allowedDomains" must be an array of host patterns'
          )
        } else {
          const domains = na.allowedDomains
          if (domains.some((d) => typeof d !== "string" || d.trim() === "")) {
            pushError(
              "networkAccess.allowedDomains",
              "manifest.networkAccess.allowedDomains.entry.invalid",
              "Each allowedDomains entry must be a non-empty host pattern " +
                '(e.g. "api.example.com", "*.example.com", "*", or "none")'
            )
          }
          const wantsAnyHost = domains.some((d) => typeof d === "string" && d.trim() === "*")
          if (wantsAnyHost && (typeof na.reasoning !== "string" || na.reasoning.trim() === "")) {
            pushWarning(
              "networkAccess.reasoning",
              "manifest.networkAccess.reasoning.required",
              'networkAccess.allowedDomains includes "*" (any host) but no "reasoning" is given',
              'Add a "reasoning" string explaining why the plugin needs unrestricted network ' +
                "access — it is shown to the user before they enable the plugin."
            )
          }
        }
      }
    }
  }

  if (m.engines && typeof m.engines === "object") {
    const engines = m.engines as Record<string, unknown>
    if (engines.cognia) {
      if (typeof engines.cognia !== "string") {
        pushError(
          "engines.cognia",
          "manifest.engines.cognia.invalid",
          'Invalid "engines.cognia" field'
        )
      } else {
        const declaredMinimum = declaredMinimumHostVersion(engines.cognia)
        if (!declaredMinimum) {
          pushError(
            "engines.cognia",
            "manifest.engines.cognia.invalid",
            'Invalid "engines.cognia" constraint: include a semantic version such as ">=0.1.0"'
          )
        } else {
          const declared = Array.isArray(m.capabilities)
            ? new Set(
                m.capabilities.filter(
                  (capability): capability is string => typeof capability === "string"
                )
              )
            : new Set<string>()
          const requiredMinimum = AUTHOR_CAPABILITY_CONTRACTS.filter((contract) =>
            declared.has(contract.id)
          ).reduce(
            (highest, contract) =>
              compareSemver(contract.minimumHostVersion, highest) > 0
                ? contract.minimumHostVersion
                : highest,
            "0.0.0"
          )
          if (compareSemver(declaredMinimum, requiredMinimum) < 0) {
            pushError(
              "engines.cognia",
              "manifest.engines.cognia.capability_minimum",
              `engines.cognia starts at ${declaredMinimum}, but declared capabilities require Cognia ${requiredMinimum} or newer`
            )
          }
        }
      }
    }
    if (engines.python && typeof engines.python !== "string") {
      pushError(
        "engines.python",
        "manifest.engines.python.invalid",
        'Invalid "engines.python" field'
      )
    }
  }

  if (m.minAppVersion !== undefined) {
    if (typeof m.minAppVersion !== "string" || !VERSION_PATTERN.test(m.minAppVersion)) {
      pushError(
        "minAppVersion",
        "manifest.minAppVersion.invalid",
        'Invalid "minAppVersion" field. Must be semver format (e.g., 0.1.0)'
      )
    }
  }

  // requires.binaries — external CLI/binary prerequisites probed by the
  // pre-install chain. Additive: a manifest with no `requires` block is
  // unaffected. We validate shape (name required string; minVersion, when
  // present, must be semver; documentation must be a string) so a typo'd
  // requirement surfaces at author time rather than silently never gating.
  if (m.requires !== undefined) {
    if (typeof m.requires !== "object" || m.requires === null || Array.isArray(m.requires)) {
      pushError("requires", "manifest.requires.invalid", '"requires" must be an object')
    } else {
      const requires = m.requires as Record<string, unknown>
      if (requires.binaries !== undefined) {
        if (!Array.isArray(requires.binaries)) {
          pushError(
            "requires.binaries",
            "manifest.requires.binaries.invalid",
            '"requires.binaries" must be an array'
          )
        } else {
          requires.binaries.forEach((entry, i) => {
            const field = `requires.binaries[${i}]`
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              pushError(
                field,
                "manifest.requires.binaries.entry.invalid",
                `${field} must be an object`
              )
              return
            }
            const bin = entry as Record<string, unknown>
            if (!bin.name || typeof bin.name !== "string") {
              pushError(
                `${field}.name`,
                "manifest.requires.binaries.name.missing",
                `${field} requires a non-empty "name" string`
              )
            }
            if (bin.minVersion !== undefined) {
              if (typeof bin.minVersion !== "string" || !VERSION_PATTERN.test(bin.minVersion)) {
                pushError(
                  `${field}.minVersion`,
                  "manifest.requires.binaries.minVersion.invalid",
                  `${field}.minVersion must be semver format (e.g., 0.1.0)`
                )
              }
            }
            if (bin.documentation !== undefined && typeof bin.documentation !== "string") {
              pushError(
                `${field}.documentation`,
                "manifest.requires.binaries.documentation.invalid",
                `${field}.documentation must be a string URL`
              )
            }
          })
        }
      }
    }
  }

  if (m.configSchema) {
    const schemaResult = validateConfigSchema(m.configSchema)
    for (const error of schemaResult.errors) {
      pushError("configSchema", "manifest.configSchema.invalid", error)
    }
    for (const warning of schemaResult.warnings) {
      pushWarning("configSchema", "manifest.configSchema.warning", warning)
    }
  }

  if (m.a2uiComponents && Array.isArray(m.a2uiComponents)) {
    for (let i = 0; i < m.a2uiComponents.length; i++) {
      const comp = m.a2uiComponents[i] as Record<string, unknown>
      if (!comp.type || typeof comp.type !== "string") {
        pushError(
          `a2uiComponents[${i}].type`,
          "manifest.a2ui.type.missing",
          `A2UI component at index ${i} missing "type" field`
        )
      }
      if (!comp.name || typeof comp.name !== "string") {
        pushError(
          `a2uiComponents[${i}].name`,
          "manifest.a2ui.name.missing",
          `A2UI component at index ${i} missing "name" field`
        )
      }
    }
  }

  if (m.tools && Array.isArray(m.tools)) {
    for (let i = 0; i < m.tools.length; i++) {
      const tool = m.tools[i] as Record<string, unknown>
      if (!tool.name || typeof tool.name !== "string") {
        pushError(
          `tools[${i}].name`,
          "manifest.tools.name.missing",
          `Tool at index ${i} missing "name" field`
        )
      }
      if (!tool.description || typeof tool.description !== "string") {
        pushError(
          `tools[${i}].description`,
          "manifest.tools.description.missing",
          `Tool at index ${i} missing "description" field`
        )
      }
      if (tool.parametersSchema !== undefined && typeof tool.parametersSchema !== "object") {
        pushError(
          `tools[${i}].parametersSchema`,
          "manifest.tools.parametersSchema.invalid",
          `Tool at index ${i} has invalid "parametersSchema" field (must be an object)`
        )
      }
    }
  }

  // cliTools[] — declarative CLI wrappers. Strict by design: a malformed
  // entry could otherwise turn into an argv-injection or path-escape hole,
  // so every structural rule the executor relies on is enforced at author
  // time (argv params declared, binary refs resolvable, no traversal).
  if (m.cliTools !== undefined) {
    validateCliTools(m as unknown as PluginManifest, pushError)
  }

  if (m.modes && Array.isArray(m.modes)) {
    for (let i = 0; i < m.modes.length; i++) {
      const mode = m.modes[i] as Record<string, unknown>
      if (!mode.id || typeof mode.id !== "string") {
        pushError(
          `modes[${i}].id`,
          "manifest.modes.id.missing",
          `Mode at index ${i} missing "id" field`
        )
      }
      if (!mode.name || typeof mode.name !== "string") {
        pushError(
          `modes[${i}].name`,
          "manifest.modes.name.missing",
          `Mode at index ${i} missing "name" field`
        )
      }
      if (!mode.icon || typeof mode.icon !== "string") {
        pushError(
          `modes[${i}].icon`,
          "manifest.modes.icon.missing",
          `Mode at index ${i} missing "icon" field`
        )
      }
    }
  }

  if (m.commands && Array.isArray(m.commands)) {
    for (let i = 0; i < m.commands.length; i++) {
      const command = m.commands[i] as Record<string, unknown>
      if (!command.id || typeof command.id !== "string") {
        pushError(
          `commands[${i}].id`,
          "manifest.commands.id.missing",
          `Command at index ${i} missing "id" field`
        )
      }
      if (!command.name || typeof command.name !== "string") {
        pushError(
          `commands[${i}].name`,
          "manifest.commands.name.missing",
          `Command at index ${i} missing "name" field`
        )
      }
      if (command.description !== undefined && typeof command.description !== "string") {
        pushError(
          `commands[${i}].description`,
          "manifest.commands.description.invalid",
          `Command at index ${i} has invalid "description" field`
        )
      }
      if (command.icon !== undefined && typeof command.icon !== "string") {
        pushError(
          `commands[${i}].icon`,
          "manifest.commands.icon.invalid",
          `Command at index ${i} has invalid "icon" field`
        )
      }
      if (command.aliases !== undefined) {
        if (!Array.isArray(command.aliases)) {
          pushError(
            `commands[${i}].aliases`,
            "manifest.commands.aliases.invalid",
            `Command at index ${i} has invalid "aliases" field (must be an array)`
          )
        } else if (!command.aliases.every((alias) => typeof alias === "string")) {
          pushError(
            `commands[${i}].aliases`,
            "manifest.commands.aliases.invalid_type",
            `Command at index ${i} has invalid "aliases" field (must contain strings)`
          )
        }
      }
    }
  }

  if (m.activationEvents !== undefined) {
    if (!Array.isArray(m.activationEvents)) {
      pushError(
        "activationEvents",
        "manifest.activationEvents.invalid_type",
        '"activationEvents" must be an array'
      )
    } else {
      for (let i = 0; i < m.activationEvents.length; i++) {
        const event = m.activationEvents[i]
        if (typeof event !== "string") {
          pushError(
            `activationEvents[${i}]`,
            "manifest.activationEvents.invalid_item",
            `Activation event at index ${i} must be a string`
          )
          continue
        }

        const outcome = validateActivationEvent(event, { governanceMode })
        for (const diagnostic of outcome.diagnostics) {
          const field = `activationEvents[${i}]`
          const code = `manifest.activationEvents.${diagnostic.code}`
          if (diagnostic.severity === "error") {
            pushError(field, code, diagnostic.message, diagnostic.hint)
          } else {
            pushWarning(field, code, diagnostic.message, diagnostic.hint)
          }
        }
      }
    }
  }

  if (m.activateOnStartup !== undefined && typeof m.activateOnStartup !== "boolean") {
    pushError(
      "activateOnStartup",
      "manifest.activateOnStartup.invalid_type",
      '"activateOnStartup" must be a boolean'
    )
  }

  if (m.dexie !== undefined) {
    if (!m.dexie || typeof m.dexie !== "object") {
      pushError("dexie", "manifest.dexie.invalid_type", '"dexie" must be an object if provided')
    } else {
      const dexie = m.dexie as Record<string, unknown>
      if (!Array.isArray(dexie.tables)) {
        pushError(
          "dexie.tables",
          "manifest.dexie.tables.missing",
          '"dexie.tables" must be an array'
        )
      } else {
        if (dexie.tables.length === 0) {
          pushError(
            "dexie.tables",
            "manifest.dexie.tables.empty",
            '"dexie.tables" must not be empty'
          )
        }
        if (dexie.tables.length > MAX_TABLES_PER_PLUGIN) {
          pushError(
            "dexie.tables",
            "manifest.dexie.tables.tooMany",
            `"dexie.tables" exceeds the maximum of ${MAX_TABLES_PER_PLUGIN}`
          )
        }
        const seen = new Set<string>()
        for (let i = 0; i < dexie.tables.length; i++) {
          const t = dexie.tables[i] as Record<string, unknown>
          if (!t || typeof t !== "object") {
            pushError(
              `dexie.tables[${i}]`,
              "manifest.dexie.tables.invalid_item",
              `Table at index ${i} must be an object`
            )
            continue
          }
          if (typeof t.name !== "string" || !isValidPluginTableName(t.name)) {
            pushError(
              `dexie.tables[${i}].name`,
              "manifest.dexie.tables.nameInvalid",
              `Table name at index ${i} is invalid: must match ^[a-z][a-zA-Z0-9_]{0,30}$`
            )
          } else if (seen.has(t.name)) {
            pushError(
              `dexie.tables[${i}].name`,
              "manifest.dexie.tables.duplicate",
              `Duplicate table name "${t.name}"`
            )
          } else {
            seen.add(t.name)
          }
          if (typeof t.schema !== "string" || t.schema.trim().length === 0) {
            pushError(
              `dexie.tables[${i}].schema`,
              "manifest.dexie.tables.schemaInvalid",
              `Table at index ${i} missing or empty "schema"`
            )
          }
        }
      }

      if (dexie.migrations !== undefined) {
        if (!Array.isArray(dexie.migrations)) {
          pushError(
            "dexie.migrations",
            "manifest.dexie.migrations.invalid",
            '"dexie.migrations" must be an array if provided'
          )
        } else {
          for (let i = 0; i < dexie.migrations.length; i++) {
            const mig = dexie.migrations[i] as Record<string, unknown>
            if (!mig || typeof mig !== "object") {
              pushError(
                `dexie.migrations[${i}]`,
                "manifest.dexie.migrations.invalid_item",
                `Migration at index ${i} must be an object`
              )
              continue
            }
            if (
              typeof mig.toVersion !== "number" ||
              !Number.isInteger(mig.toVersion) ||
              mig.toVersion < 1
            ) {
              pushError(
                `dexie.migrations[${i}].toVersion`,
                "manifest.dexie.migrations.toVersionInvalid",
                `Migration at index ${i} requires positive integer "toVersion"`
              )
            }
            if (typeof mig.upgrade !== "string" || mig.upgrade.length === 0) {
              pushError(
                `dexie.migrations[${i}].upgrade`,
                "manifest.dexie.migrations.upgradeInvalid",
                `Migration at index ${i} requires non-empty "upgrade" function name`
              )
            }
          }
        }
      }
    }
  }

  // ── Resilience policy (timeout / retry / circuit-breaker) ───────────────────
  if (m.resilience !== undefined) {
    if (!m.resilience || typeof m.resilience !== "object") {
      pushError(
        "resilience",
        "manifest.resilience.invalid_type",
        '"resilience" must be an object if provided'
      )
    } else {
      const r = m.resilience as Record<string, unknown>
      const checkPositiveInt = (key: string, value: unknown): void => {
        if (value === undefined) return
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          pushError(
            `resilience.${key}`,
            "manifest.resilience.invalid_number",
            `"resilience.${key}" must be a positive integer`
          )
        }
      }
      const checkNonNegativeInt = (key: string, value: unknown): void => {
        if (value === undefined) return
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          pushError(
            `resilience.${key}`,
            "manifest.resilience.invalid_number",
            `"resilience.${key}" must be a non-negative integer`
          )
        }
      }
      checkPositiveInt("timeoutMs", r.timeoutMs)
      checkNonNegativeInt("maxRetries", r.maxRetries)
      if (r.retryable !== undefined && typeof r.retryable !== "boolean") {
        pushError(
          "resilience.retryable",
          "manifest.resilience.invalid_boolean",
          '"resilience.retryable" must be a boolean'
        )
      }
      if (
        r.breakerScope !== undefined &&
        r.breakerScope !== "tool" &&
        r.breakerScope !== "plugin"
      ) {
        pushError(
          "resilience.breakerScope",
          "manifest.resilience.invalid_scope",
          '"resilience.breakerScope" must be "tool" or "plugin"'
        )
      }
      if (r.breaker !== undefined) {
        if (!r.breaker || typeof r.breaker !== "object") {
          pushError(
            "resilience.breaker",
            "manifest.resilience.breaker.invalid_type",
            '"resilience.breaker" must be an object if provided'
          )
        } else {
          const b = r.breaker as Record<string, unknown>
          checkPositiveInt("breaker.failureThreshold", b.failureThreshold)
          checkPositiveInt("breaker.cooldownMs", b.cooldownMs)
          checkPositiveInt("breaker.successThreshold", b.successThreshold)
        }
      }
      // Warn when the worst-case budget could exceed the sidecar IPC ceiling.
      // Reuse the single source of truth in the resilience layer rather than
      // re-implementing the math (and the 120s constant) here.
      const budgetWarning = checkResilienceBudget(
        resolveResilienceConfig({ resilience: r as PluginResilienceConfig })
      )
      if (budgetWarning) {
        pushWarning("resilience.timeoutMs", "manifest.resilience.budget_exceeds_ipc", budgetWarning)
      }
    }
  }

  // ── ADR-0026 lazy-factory fields ────────────────────────────────────────────
  // Each of the six new manifest blocks shares the `{ id, label, entry,
  // export }` shape. `validateLazyFactoryArray` enforces the shared rules;
  // the `extra` callback runs field-specific checks (e.g. `kind` for
  // aiProviders, `partType` for messageRenderers).

  validateLazyFactoryArray(
    m.ocrProviders,
    { field: "ocrProviders" },
    pushError,
    pushWarning,
    m.type
  )

  validateDeclarativeExtensions(m as unknown as PluginManifest, pushError)
  validateDeclarativeTrayItems(m as unknown as PluginManifest, pushError)
  validateIntegrations(m as unknown as PluginManifest, pushError)
  validateWorkflowKindAliases(m as unknown as PluginManifest, pushError)
  validateNativeLucideIcons(m as unknown as PluginManifest, pushError, pushWarning)
  validateLazyFactoryArray(
    m.workspaceBackends,
    { field: "workspaceBackends" },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.messageRenderers,
    {
      field: "messageRenderers",
      requireLabel: false,
      extra: (entry, _i, push) => {
        if (typeof entry.partType !== "string" || entry.partType.length === 0) {
          push("error", "partType.missing", `messageRenderers entry requires a "partType" string`)
        }
      },
    },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.aiProviders,
    {
      field: "aiProviders",
      extra: (entry, _i, push) => {
        if (entry.kind !== "llm" && entry.kind !== "embedding") {
          push("error", "kind.invalid", `aiProviders entry "kind" must be "llm" or "embedding"`)
          return
        }
        if (entry.kind === "embedding") {
          if (
            typeof entry.dimensions !== "number" ||
            !Number.isInteger(entry.dimensions) ||
            entry.dimensions <= 0
          ) {
            push(
              "error",
              "dimensions.invalid",
              `aiProviders embedding entry requires positive integer "dimensions"`
            )
          }
        }
        if (entry.kind === "llm" && entry.models !== undefined) {
          if (
            !Array.isArray(entry.models) ||
            !(entry.models as unknown[]).every((s) => typeof s === "string")
          ) {
            push("error", "models.invalid", `aiProviders llm entry "models" must be string[]`)
          }
        }
      },
    },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.modalMounts,
    {
      field: "modalMounts",
      extra: (entry, _i, push) => {
        if (entry.options === undefined) return
        if (!isPlainObject(entry.options)) {
          push("error", "options.invalid", `modalMounts "options" must be an object if provided`)
          return
        }
        // Rejected loudly here and merely ignored at render time on purpose:
        // the author gets the failure at install, while an already-installed
        // manifest that predates a value being removed still opens its modal.
        const { size, variant } = entry.options
        if (size !== undefined && !PLUGIN_MODAL_SIZES.includes(size as never)) {
          push(
            "error",
            "options.size.invalid",
            `modalMounts "options.size" must be one of ${PLUGIN_MODAL_SIZES.join(", ")}`
          )
        }
        if (variant !== undefined && !PLUGIN_MODAL_VARIANTS.includes(variant as never)) {
          push(
            "error",
            "options.variant.invalid",
            `modalMounts "options.variant" must be one of ${PLUGIN_MODAL_VARIANTS.join(", ")}`
          )
        }
      },
    },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.routingStrategies,
    { field: "routingStrategies" },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.chatMiddlewares,
    {
      field: "chatMiddlewares",
      extra: (entry, _i, push) => {
        if (entry.priority !== undefined) {
          if (typeof entry.priority !== "number" || entry.priority < -100 || entry.priority > 100) {
            push("error", "priority.range", `chatMiddlewares "priority" must be in [-100, 100]`)
          }
        }
        if (entry.timeoutMs !== undefined) {
          if (
            typeof entry.timeoutMs !== "number" ||
            entry.timeoutMs <= 0 ||
            entry.timeoutMs > 60_000
          ) {
            push("error", "timeoutMs.range", `chatMiddlewares "timeoutMs" must be in (0, 60000]`)
          }
        }
      },
    },
    pushError,
    pushWarning,
    m.type
  )
  validateLazyFactoryArray(
    m.contextPanels,
    {
      field: "contextPanels",
      // A `webview`-backed panel has no JS module: its body is a sandboxed
      // iframe resolved from `manifest.webviews[]` at render time.
      moduleOptional: (entry) => typeof entry.webview === "string" && entry.webview.length > 0,
      extra: (entry, _i, push) => {
        if (entry.webview !== undefined) {
          if (typeof entry.webview !== "string" || entry.webview.length === 0) {
            push(
              "error",
              "webview.invalid",
              `contextPanels "webview" must be a non-empty webview id string`
            )
          } else {
            const conflicting = (
              [
                "entry",
                "export",
                "onFirstActivateExport",
                "onRestoreExport",
                "getBadgeExport",
              ] as const
            ).filter((field) => entry[field] !== undefined)
            if (conflicting.length > 0) {
              push(
                "error",
                "webview.conflict",
                `contextPanels "webview" is mutually exclusive with ${conflicting.join(", ")}`
              )
            }
            if (Array.isArray(m.webviews)) {
              const known = m.webviews.some(
                (candidate) => isPlainObject(candidate) && candidate.id === entry.webview
              )
              if (!known) {
                push(
                  "error",
                  "webview.unknown",
                  `contextPanels "webview" references "${entry.webview}", which is not in "webviews"`
                )
              }
            } else {
              // First-party plugins carry contributions on the module-manifest
              // overlay, so the raw JSON may legitimately lack `webviews[]` —
              // the merged manifest is what the manager validates at enable.
              push(
                "warning",
                "webview.unresolved",
                `contextPanels "webview" references "${entry.webview}" but "webviews" is not declared here; the merged manifest must provide it`
              )
            }
          }
        }
        // Shares its source with the imperative API's gate for the same reason
        // the activity list below does: this map used to be a hand-copied
        // literal that omitted `session` — the chat dock's own fallback
        // resource kind — so a declarative panel targeting the right rail's
        // default state passed tsc and then failed to install.
        const resourcePermissions = CONTEXT_RESOURCE_READ_PERMISSIONS
        const resourceKinds = entry.resourceKinds
        if (
          !Array.isArray(resourceKinds) ||
          resourceKinds.length === 0 ||
          !resourceKinds.every((kind) => typeof kind === "string" && kind in resourcePermissions)
        ) {
          push(
            "error",
            "resourceKinds.invalid",
            `contextPanels "resourceKinds" must be a non-empty array of supported resource kinds`
          )
        }
        // Shares its source with `CanonicalContextActivity`, which is what the
        // SDK's `defineContextPanel` types against — a hand-copied list here
        // let `workspace` pass tsc and then fail manifest validation.
        const activities = new Set<string>(CANONICAL_CONTEXT_ACTIVITIES)
        if (typeof entry.activity !== "string" || !activities.has(entry.activity)) {
          push("error", "activity.invalid", `contextPanels "activity" must be canonical`)
        }
        if (typeof entry.labelKey !== "string" || entry.labelKey.length === 0) {
          push("error", "labelKey.missing", `contextPanels entry requires a "labelKey" string`)
        }
        if (entry.icon !== undefined && !isExportedLucideIcon(String(entry.icon))) {
          // `PLUGIN_CONTEXT_PANEL_ICONS` published exactly these in kebab-case,
          // so this is the surface most likely to be holding the old spelling.
          if (
            typeof entry.icon === "string" &&
            isExportedLucideIcon(toLucideIconName(entry.icon))
          ) {
            push(
              "warning",
              "icon.legacy_kebab_case",
              `contextPanels "icon" uses the retired kebab-case name "${entry.icon}"; rename it to "${toLucideIconName(entry.icon)}"`
            )
          } else {
            push("error", "icon.invalid", `contextPanels "icon" is not a valid lucide icon name`)
          }
        }
        if (
          entry.preferredMode !== undefined &&
          !["narrow", "wide", "focus"].includes(String(entry.preferredMode))
        ) {
          push("error", "preferredMode.invalid", `contextPanels "preferredMode" is invalid`)
        }
        if (
          entry.retention !== undefined &&
          entry.retention !== "stateful" &&
          entry.retention !== "ephemeral"
        ) {
          push("error", "retention.invalid", `contextPanels "retention" is invalid`)
        }
        // Behaviour hooks are named exports of the same entry module, so the
        // only thing checkable here is that a declared name is a usable one —
        // the bridge reports a missing export at registration time.
        for (const field of [
          "onFirstActivateExport",
          "onRestoreExport",
          "getBadgeExport",
        ] as const) {
          const value = entry[field]
          if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
            push("error", `${field}.invalid`, `contextPanels "${field}" must be a non-empty string`)
          }
        }
        if (entry.requiresChatScope !== undefined && typeof entry.requiresChatScope !== "boolean") {
          push(
            "error",
            "requiresChatScope.invalid",
            `contextPanels "requiresChatScope" must be a boolean`
          )
        }
        const declaredPermissions = new Set(
          Array.isArray(m.permissions)
            ? m.permissions.filter(
                (permission): permission is string => typeof permission === "string"
              )
            : []
        )
        const requiredPermissions = [
          "extension:ui",
          ...(Array.isArray(resourceKinds)
            ? resourceKinds
                .filter((kind): kind is string => typeof kind === "string")
                // `kind` comes straight out of an untrusted manifest, so it is
                // a plain string that may name no known resource. A miss is
                // expected and dropped by the Boolean filter below.
                .map((kind) => (resourcePermissions as Record<string, string | undefined>)[kind])
                .filter((permission): permission is string => Boolean(permission))
            : []),
        ]
        const missing = requiredPermissions.find(
          (permission) => !declaredPermissions.has(permission as PluginPermission)
        )
        if (missing) {
          push(
            "error",
            "permission.missing",
            `contextPanels entry requires manifest permission "${missing}"`
          )
        }
      },
    },
    pushError,
    pushWarning,
    m.type
  )

  // ── i18n block ──────────────────────────────────────────────────────────────
  // Plugin-supplied localized strings. Validated as a flat per-locale string
  // map; merged into the host bundle under `plugin.<id>.` by the manager.
  if (m.i18n !== undefined) {
    if (!m.i18n || typeof m.i18n !== "object" || Array.isArray(m.i18n)) {
      pushError("i18n", "manifest.i18n.invalid", '"i18n" must be an object')
    } else {
      const i18nBlock = m.i18n as Record<string, unknown>
      const locales = i18nBlock.locales
      if (!locales || typeof locales !== "object" || Array.isArray(locales)) {
        pushError(
          "i18n.locales",
          "manifest.i18n.locales.invalid",
          '"i18n.locales" must be an object keyed by locale code'
        )
      } else {
        const I18N_KEY_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/
        const MAX_KEYS_PER_LOCALE = 1000
        const HOST_LOCALES = new Set(["en", "zh-CN"])
        for (const [locale, dict] of Object.entries(locales as Record<string, unknown>)) {
          if (!HOST_LOCALES.has(locale)) {
            pushWarning(
              `i18n.locales.${locale}`,
              "manifest.i18n.invalid_locale",
              `Locale "${locale}" is not one of the host's canonical locales (${[...HOST_LOCALES].join(", ")}); plugin strings for this locale will never resolve.`
            )
            continue
          }
          if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
            pushError(
              `i18n.locales.${locale}`,
              "manifest.i18n.invalid_keys",
              `Locale "${locale}" must be a flat string map (no nested objects or arrays).`
            )
            continue
          }
          const entries = Object.entries(dict as Record<string, unknown>)
          if (entries.length > MAX_KEYS_PER_LOCALE) {
            pushError(
              `i18n.locales.${locale}`,
              "manifest.i18n.too_many_keys",
              `Locale "${locale}" declares ${entries.length} keys; the per-locale cap is ${MAX_KEYS_PER_LOCALE}.`
            )
          }
          for (const [key, value] of entries) {
            if (!I18N_KEY_PATTERN.test(key)) {
              pushError(
                `i18n.locales.${locale}.${key}`,
                "manifest.i18n.invalid_keys",
                `Key "${key}" must match ${I18N_KEY_PATTERN.source}.`
              )
            }
            if (typeof value !== "string") {
              pushError(
                `i18n.locales.${locale}.${key}`,
                "manifest.i18n.invalid_keys",
                `Value for "${key}" must be a string.`
              )
            }
          }
        }
      }
    }
  }

  const localizedLabelPaths = [
    "views[].titleKey",
    "viewsContainers[].titleKey",
    "webviews[].titleKey",
    "quickActions[].labelKey",
    "modalMounts[].labelKey",
    "contextPanels[].labelKey",
    "extensions[].labelKey",
    "trayItems[].labelKey",
  ] as const
  const localeMaps =
    isPlainObject(m.i18n) && isPlainObject(m.i18n.locales)
      ? Object.entries(m.i18n.locales).filter((entry): entry is [string, Record<string, unknown>] =>
          isPlainObject(entry[1])
        )
      : []
  for (const path of localizedLabelPaths) {
    for (const { field, value } of collectCatalogPathValues(m, path.split("."))) {
      if (typeof value !== "string" || value.length === 0) {
        pushError(
          field,
          "manifest.i18n.key.invalid",
          `"${field}" must be a non-empty plugin i18n key`
        )
        continue
      }
      if (localeMaps.length === 0) {
        pushError(
          field,
          "manifest.i18n.key.missing",
          `"${field}" declares "${value}" but manifest.i18n.locales is empty`
        )
        continue
      }
      for (const [locale, messages] of localeMaps) {
        if (!Object.prototype.hasOwnProperty.call(messages, value)) {
          pushError(
            field,
            "manifest.i18n.key.missing",
            `"${field}" references missing key "${value}" in locale "${locale}"`
          )
        }
      }
    }
  }

  if (
    typeof m.id === "string" &&
    (m.ide !== undefined ||
      m.vscodeLanguages !== undefined ||
      m.vscodeGrammars !== undefined ||
      m.vscodeIconThemes !== undefined ||
      m.vscodeSnippets !== undefined)
  ) {
    try {
      const normalized = normalizeIdeManifest(
        m.id,
        m as unknown as Parameters<typeof normalizeIdeManifest>[1]
      )
      for (const warning of normalized.warnings) {
        pushWarning(
          "ide",
          "manifest.ide.legacy_deprecated",
          warning,
          "Move legacy vscode* fields into manifest.ide before the next major release."
        )
      }
    } catch (error) {
      if (error instanceof IdeManifestError) {
        pushError(error.field ?? "ide", `manifest.ide.${error.code.toLowerCase()}`, error.message)
      } else {
        pushError("ide", "manifest.ide.invalid", String(error))
      }
    }
  }

  const errors = diagnostics.filter((item) => item.severity === "error").map((item) => item.message)
  const warnings = diagnostics
    .filter((item) => item.severity === "warning")
    .map((item) => item.message)

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    diagnostics,
  }
}

// =============================================================================
// Config Schema Validation
// =============================================================================

function validateConfigSchema(schema: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!schema || typeof schema !== "object") {
    return { valid: false, errors: ["Config schema must be an object"], warnings: [] }
  }

  const s = schema as Record<string, unknown>

  if (s.type !== "object") {
    errors.push('Config schema root type must be "object"')
  }

  if (s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      const propResult = validateConfigProperty(key, value)
      errors.push(...propResult.errors)
      warnings.push(...propResult.warnings)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateConfigProperty(name: string, prop: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!prop || typeof prop !== "object") {
    errors.push(`Config property "${name}" must be an object`)
    return { valid: false, errors, warnings }
  }

  const p = prop as Record<string, unknown>
  const validTypes = ["string", "number", "integer", "boolean", "array", "object"]

  if (!p.type || typeof p.type !== "string") {
    errors.push(`Config property "${name}" missing "type" field`)
  } else if (!validTypes.includes(p.type)) {
    errors.push(`Config property "${name}" has invalid type "${p.type}"`)
  }

  if (p.type === "array" && p.items) {
    const itemsResult = validateConfigProperty(`${name}.items`, p.items)
    errors.push(...itemsResult.errors)
    warnings.push(...itemsResult.warnings)
  }

  if (p.type === "object" && p.properties) {
    const props = p.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      const propResult = validateConfigProperty(`${name}.${key}`, value)
      errors.push(...propResult.errors)
      warnings.push(...propResult.warnings)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// =============================================================================
// Config Value Validation
// =============================================================================

export function validatePluginConfig(
  config: Record<string, unknown>,
  schema?: PluginConfigSchema
): ConfigValidationResult {
  const errors: ValidationError[] = []
  const warnings: string[] = []

  // If no schema provided, any config is valid
  if (!schema) {
    return { valid: true, errors: [], warnings: [] }
  }

  // Check required fields
  if (schema.required) {
    for (const required of schema.required) {
      if (config[required] === undefined) {
        errors.push({
          field: required,
          code: "required",
          message: `Missing required config field: ${required}`,
        })
      }
    }
  }

  // Validate each property
  for (const [key, value] of Object.entries(config)) {
    const propSchema = schema.properties[key]
    if (!propSchema) {
      warnings.push(`Unknown config field: ${key}`)
      continue
    }

    const propErrors = validateConfigValueWithErrors(key, value, propSchema)
    errors.push(...propErrors)
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateConfigValueWithErrors(
  name: string,
  value: unknown,
  schema: PluginConfigProperty
): ValidationError[] {
  const errors: ValidationError[] = []

  // Type check. "integer" accepts a JS number whose value is a whole number;
  // everything else maps 1:1 onto the JS runtime type tag.
  const actualType = Array.isArray(value) ? "array" : typeof value
  const expectedRuntimeType = schema.type === "integer" ? "number" : schema.type
  if (actualType !== expectedRuntimeType) {
    errors.push({
      field: name,
      code: "invalid_type",
      message: `Config field "${name}" expected type "${schema.type}" but got "${actualType}"`,
    })
    return errors
  }
  if (schema.type === "integer" && typeof value === "number" && !Number.isInteger(value)) {
    errors.push({
      field: name,
      code: "invalid_type",
      message: `Config field "${name}" must be an integer`,
    })
  }

  // Enum check
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({
      field: name,
      code: "enum",
      message: `Config field "${name}" value must be one of: ${schema.enum.join(", ")}`,
    })
  }

  // String validations
  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        field: name,
        code: "minLength",
        message: `Config field "${name}" must be at least ${schema.minLength} characters`,
      })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        field: name,
        code: "maxLength",
        message: `Config field "${name}" must be at most ${schema.maxLength} characters`,
      })
    }
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern)
      if (!regex.test(value)) {
        errors.push({
          field: name,
          code: "pattern",
          message: `Config field "${name}" does not match pattern: ${schema.pattern}`,
        })
      }
    }
  }

  // Number validations (apply to both "number" and "integer")
  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        field: name,
        code: "minimum",
        message: `Config field "${name}" must be at least ${schema.minimum}`,
      })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        field: name,
        code: "maximum",
        message: `Config field "${name}" must be at most ${schema.maximum}`,
      })
    }
  }

  // Array validations
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateConfigValueWithErrors(`${name}[${i}]`, value[i], schema.items)
      errors.push(...itemErrors)
    }
  }

  // Object validations
  if (
    schema.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    schema.properties
  ) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const propValue = (value as Record<string, unknown>)[key]
      if (propValue !== undefined) {
        const propErrors = validateConfigValueWithErrors(`${name}.${key}`, propValue, propSchema)
        errors.push(...propErrors)
      }
    }
  }

  return errors
}

// =============================================================================
// Manifest Parser
// =============================================================================

export function parseManifest(content: string): PluginManifest | null {
  try {
    const parsed = JSON.parse(content)
    const validation = validatePluginManifest(parsed)

    if (!validation.valid) {
      loggers.manager.error("Invalid plugin manifest:", validation.errors)
      return null
    }

    if (validation.warnings.length > 0) {
      loggers.manager.warn("Plugin manifest warnings:", validation.warnings)
    }

    return parsed as PluginManifest
  } catch (error) {
    loggers.manager.error("Failed to parse plugin manifest:", error)
    return null
  }
}

// =============================================================================
// cliTools validation (declarative CLI wrappers)
// =============================================================================

const CLI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const CLI_OUTPUT_PARSE_VALUES = new Set(["text", "json", "lines"])
const CLI_CWD_KINDS = new Set(["plugin-dir", "workspace", "param", "none"])
const CLI_BINARY_KINDS = new Set(["requires", "plugin-dir"])

/**
 * Declared parameter names from a cliTool's JSON-schema `parameters`
 * object. The executor builds zod from the same shape, so validation
 * insists on the canonical `{ type?: "object", properties: { … } }` form.
 * Returns null when the shape is unusable.
 */
function cliDeclaredParams(parameters: unknown): Set<string> | null {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return null
  }
  const schema = parameters as Record<string, unknown>
  if (schema.type !== undefined && schema.type !== "object") {
    return null
  }
  const properties = schema.properties
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return null
  }
  return new Set(Object.keys(properties))
}

/** Absolute paths and `..` segments can escape the plugin dir. */
function cliHasPathTraversal(relPath: string): boolean {
  if (relPath.length === 0) return true
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return true
  if (/^[A-Za-z]:/.test(relPath)) return true
  return relPath.split(/[\\/]+/).some((segment) => segment === "..")
}

type PushDiagnostic = (field: string, code: string, message: string, hint?: string) => void

/**
 * Structural validation for `manifest.cliTools[]`. Strict on purpose —
 * every rule here is one the executor's safety model relies on (argv
 * params declared, binary refs resolvable, no path traversal).
 */
function validateCliTools(m: PluginManifest, pushError: PushDiagnostic): void {
  const cliTools = m.cliTools as unknown
  if (!Array.isArray(cliTools)) {
    pushError("cliTools", "manifest.cliTools.invalid", '"cliTools" must be an array')
    return
  }
  if (cliTools.length > 0 && !(m.permissions ?? []).includes("cli:execute")) {
    pushError(
      "permissions",
      "manifest.cliTools.permission.missing",
      'cliTools entries require the "cli:execute" permission',
      'Add "cli:execute" to "permissions".'
    )
  }

  const requiredBinaryNames = new Set(
    (Array.isArray(m.requires?.binaries) ? m.requires.binaries : [])
      .map((entry) => (entry as { name?: unknown } | null | undefined)?.name)
      .filter((name): name is string => typeof name === "string")
  )
  const seenNames = new Set<string>()

  cliTools.forEach((entry, i) => {
    const field = `cliTools[${i}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      pushError(field, "manifest.cliTools.entry.invalid", `${field} must be an object`)
      return
    }
    const tool = entry as Record<string, unknown>

    if (typeof tool.name !== "string" || !CLI_TOOL_NAME_PATTERN.test(tool.name)) {
      pushError(
        `${field}.name`,
        "manifest.cliTools.name.invalid",
        `${field}.name must match ${CLI_TOOL_NAME_PATTERN} (snake_case)`
      )
    } else if (seenNames.has(tool.name)) {
      pushError(
        `${field}.name`,
        "manifest.cliTools.name.duplicate",
        `${field}.name "${tool.name}" is declared more than once`
      )
    } else {
      seenNames.add(tool.name)
    }

    if (!tool.description || typeof tool.description !== "string") {
      pushError(
        `${field}.description`,
        "manifest.cliTools.description.missing",
        `${field} requires a non-empty "description" string`
      )
    }

    const declaredParams = cliDeclaredParams(tool.parameters)
    if (declaredParams === null) {
      pushError(
        `${field}.parameters`,
        "manifest.cliTools.parameters.invalid",
        `${field}.parameters must be a JSON-schema object: { "type": "object", "properties": { … } }`
      )
    }
    const hasParam = (name: string): boolean => declaredParams?.has(name) ?? false

    const binary = tool.binary as Record<string, unknown> | undefined
    if (!binary || typeof binary !== "object" || Array.isArray(binary)) {
      pushError(
        `${field}.binary`,
        "manifest.cliTools.binary.missing",
        `${field} requires a "binary" reference object`
      )
    } else if (!CLI_BINARY_KINDS.has(binary.kind as string)) {
      pushError(
        `${field}.binary.kind`,
        "manifest.cliTools.binary.kind.invalid",
        `${field}.binary.kind must be "requires" or "plugin-dir"`
      )
    } else if (binary.kind === "requires") {
      if (typeof binary.name !== "string" || binary.name.length === 0) {
        pushError(
          `${field}.binary.name`,
          "manifest.cliTools.binary.name.missing",
          `${field}.binary requires a non-empty "name"`
        )
      } else if (!requiredBinaryNames.has(binary.name)) {
        pushError(
          `${field}.binary.name`,
          "manifest.cliTools.binary.name.undeclared",
          `${field}.binary.name "${binary.name}" is not declared in requires.binaries`,
          "Add the binary to manifest.requires.binaries so the install/enable chain can probe it."
        )
      }
    } else if (binary.kind === "plugin-dir") {
      if (typeof binary.relPath !== "string" || cliHasPathTraversal(binary.relPath)) {
        pushError(
          `${field}.binary.relPath`,
          "manifest.cliTools.binary.relPath.invalid",
          `${field}.binary.relPath must be a relative path inside the plugin directory (no "..", no absolute paths)`
        )
      }
    }

    if (!Array.isArray(tool.argv)) {
      pushError(
        `${field}.argv`,
        "manifest.cliTools.argv.missing",
        `${field} requires an "argv" token array (may be empty)`
      )
    } else {
      tool.argv.forEach((token, j) => {
        const tokenField = `${field}.argv[${j}]`
        if (!token || typeof token !== "object" || Array.isArray(token)) {
          pushError(
            tokenField,
            "manifest.cliTools.argv.token.invalid",
            `${tokenField} must be a { literal } or { param } object`
          )
          return
        }
        const tk = token as Record<string, unknown>
        const isLiteral = typeof tk.literal === "string"
        const isParam = typeof tk.param === "string"
        if (isLiteral === isParam) {
          pushError(
            tokenField,
            "manifest.cliTools.argv.token.invalid",
            `${tokenField} must have exactly one of "literal" (string) or "param" (string)`
          )
          return
        }
        if (isParam && !hasParam(tk.param as string)) {
          pushError(
            `${tokenField}.param`,
            "manifest.cliTools.argv.param.undeclared",
            `${tokenField} references undeclared parameter "${tk.param}"`
          )
        }
        if (tk.eachPrefixedBy !== undefined && typeof tk.eachPrefixedBy !== "string") {
          pushError(
            `${tokenField}.eachPrefixedBy`,
            "manifest.cliTools.argv.eachPrefixedBy.invalid",
            `${tokenField}.eachPrefixedBy must be a string`
          )
        }
      })
    }

    if (tool.stdin !== undefined) {
      const stdin = tool.stdin as Record<string, unknown> | null
      if (
        !stdin ||
        typeof stdin !== "object" ||
        Array.isArray(stdin) ||
        typeof stdin.param !== "string" ||
        !hasParam(stdin.param)
      ) {
        pushError(
          `${field}.stdin`,
          "manifest.cliTools.stdin.invalid",
          `${field}.stdin must be { "param": <declared parameter name> }`
        )
      }
    }

    if (tool.cwd !== undefined) {
      const cwd = tool.cwd as Record<string, unknown> | null
      if (!cwd || typeof cwd !== "object" || !CLI_CWD_KINDS.has(cwd.kind as string)) {
        pushError(
          `${field}.cwd`,
          "manifest.cliTools.cwd.invalid",
          `${field}.cwd.kind must be one of: plugin-dir, workspace, param, none`
        )
      } else if (cwd.kind === "param" && (typeof cwd.param !== "string" || !hasParam(cwd.param))) {
        pushError(
          `${field}.cwd.param`,
          "manifest.cliTools.cwd.param.undeclared",
          `${field}.cwd references an undeclared parameter`
        )
      }
    }

    if (tool.env !== undefined) {
      const env = tool.env
      const isStringMap =
        env !== null &&
        typeof env === "object" &&
        !Array.isArray(env) &&
        Object.values(env as Record<string, unknown>).every((value) => typeof value === "string")
      if (!isStringMap) {
        pushError(
          `${field}.env`,
          "manifest.cliTools.env.invalid",
          `${field}.env must be a flat map of string values`
        )
      }
    }

    if (
      tool.timeoutMs !== undefined &&
      (typeof tool.timeoutMs !== "number" ||
        !Number.isFinite(tool.timeoutMs) ||
        tool.timeoutMs <= 0)
    ) {
      pushError(
        `${field}.timeoutMs`,
        "manifest.cliTools.timeoutMs.invalid",
        `${field}.timeoutMs must be a positive number of milliseconds`
      )
    }

    if (
      tool.maxOutputBytes !== undefined &&
      (typeof tool.maxOutputBytes !== "number" ||
        !Number.isInteger(tool.maxOutputBytes) ||
        tool.maxOutputBytes <= 0)
    ) {
      pushError(
        `${field}.maxOutputBytes`,
        "manifest.cliTools.maxOutputBytes.invalid",
        `${field}.maxOutputBytes must be a positive integer`
      )
    }

    if (
      tool.outputParse !== undefined &&
      !CLI_OUTPUT_PARSE_VALUES.has(tool.outputParse as string)
    ) {
      pushError(
        `${field}.outputParse`,
        "manifest.cliTools.outputParse.invalid",
        `${field}.outputParse must be one of: text, json, lines`
      )
    }

    if (
      tool.successExitCodes !== undefined &&
      (!Array.isArray(tool.successExitCodes) ||
        tool.successExitCodes.some((code) => !Number.isInteger(code)))
    ) {
      pushError(
        `${field}.successExitCodes`,
        "manifest.cliTools.successExitCodes.invalid",
        `${field}.successExitCodes must be an array of integers`
      )
    }

    if (tool.versionArg !== undefined && typeof tool.versionArg !== "string") {
      pushError(
        `${field}.versionArg`,
        "manifest.cliTools.versionArg.invalid",
        `${field}.versionArg must be a string`
      )
    }
  })
}
