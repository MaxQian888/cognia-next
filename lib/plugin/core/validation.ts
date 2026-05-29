/**
 * Plugin Validation - Validates plugin manifests and configurations
 */

import type {
  PluginManifest,
  PluginConfigSchema,
  PluginConfigProperty,
  PluginCapability,
  PluginPermission,
  PluginType,
} from "@/types/plugin"
import { loggers } from "./logger"
import {
  CANONICAL_PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_CONTRACTS,
  validatePluginCapabilities,
} from "@/lib/plugin/contracts/plugin-capabilities"
import {
  validateActivationEvent,
  type PluginPointGovernanceMode,
} from "@/lib/plugin/contracts/plugin-points"
import { isValidPluginTableName, MAX_TABLES_PER_PLUGIN } from "@/lib/plugin/dexie/namespace"

// =============================================================================
// Types
// =============================================================================

export interface ValidationError {
  field: string
  code: string
  message: string
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

const VALID_PERMISSIONS: PluginPermission[] = [
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
  "agent:control",
  "python:execute",
  "secrets:read",
  "secrets:write",
]

const VALID_PLUGIN_TYPES: PluginType[] = [
  "frontend",
  "python",
  "hybrid",
  "wasm",
  "vscode-extension",
]

const WASM_API_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const WASM_PREOPEN_PATH_PATTERN = /^[^\0]+$/

const ID_PATTERN = /^[a-z0-9]([a-z0-9-_.]*[a-z0-9])?$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z0-9]+)?$/i

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

const LAZY_FACTORY_ENTRY_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/
const LAZY_FACTORY_ENTRY_NUL = /\0/
const LAZY_FACTORY_ENTRY_ABS = /^(\/|[a-zA-Z]:[\\/])/
const JS_IDENT_PATTERN = /^[$_a-zA-Z][$_a-zA-Z0-9]*$/

interface LazyFactoryEntry {
  id?: unknown
  label?: unknown
  entry?: unknown
  export?: unknown
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
}

function validateLazyFactoryArray(
  raw: unknown,
  options: LazyFactoryFieldOptions,
  pushError: (field: string, code: string, message: string, hint?: string) => void,
  pushWarning: (field: string, code: string, message: string, hint?: string) => void
): void {
  const { field, requireLabel = true, extra } = options
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

    if (typeof entry.entry !== "string" || entry.entry.length === 0) {
      pushError(
        `${path}.entry`,
        `manifest.${field}.entry.missing`,
        `Entry at index ${i} requires a non-empty string "entry" (relative path)`
      )
    } else {
      if (LAZY_FACTORY_ENTRY_NUL.test(entry.entry)) {
        pushError(
          `${path}.entry`,
          `manifest.${field}.entry.invalid_chars`,
          `"entry" must not contain NUL bytes`
        )
      }
      if (LAZY_FACTORY_ENTRY_ABS.test(entry.entry)) {
        pushError(
          `${path}.entry`,
          `manifest.${field}.entry.absolute`,
          `"entry" must be a relative path (no leading "/" or drive letter)`
        )
      }
      if (LAZY_FACTORY_ENTRY_TRAVERSAL.test(entry.entry)) {
        pushError(
          `${path}.entry`,
          `manifest.${field}.entry.traversal`,
          `"entry" must not contain ".." path segments`
        )
      }
    }

    if (typeof entry.export !== "string" || entry.export.length === 0) {
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
  } else if (!ID_PATTERN.test(m.id)) {
    pushError(
      "id",
      "manifest.id.invalid_format",
      `Invalid plugin ID "${m.id}". Must be lowercase alphanumeric with hyphens/underscores/dots`
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
      return Array.isArray(value) && value.length > 0
    }
    const fieldToCapabilities = new Map<string, string[]>()
    for (const contract of PLUGIN_CAPABILITY_CONTRACTS) {
      if (contract.manifestFields.length === 0) continue
      // Skip `python`: its fields are entry points (pythonMain string /
      // pythonDependencies), validated by the type-specific block, not
      // array contributions.
      if (contract.id === "python") continue
      // declared-but-empty: capability tag present, no gating field populated.
      if (declaredSet.has(contract.id) && !contract.manifestFields.some(hasField)) {
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

  // Entry points validation based on type
  if (m.type === "frontend" || m.type === "hybrid") {
    if (!m.main || typeof m.main !== "string") {
      if (m.type === "frontend") {
        pushError(
          "main",
          "manifest.main.required",
          'Frontend plugin must have a "main" entry point',
          "Add a valid relative JS entry file path in `main`."
        )
      }
    }
  }

  if (m.type === "python" || m.type === "hybrid") {
    if (!m.pythonMain || typeof m.pythonMain !== "string") {
      if (m.type === "python") {
        pushError(
          "pythonMain",
          "manifest.pythonMain.required",
          'Python plugin must have a "pythonMain" entry point',
          "Add a valid relative Python entry file path in `pythonMain`."
        )
      }
    }
  }

  if (m.type === "wasm") {
    if (!m.wasmMain || typeof m.wasmMain !== "string") {
      pushError(
        "wasmMain",
        "manifest.wasmMain.required",
        'WASM plugin must have a "wasmMain" entry point',
        "Set `wasmMain` to the relative path of the compiled `.wasm` component."
      )
    } else if (!m.wasmMain.toLowerCase().endsWith(".wasm")) {
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

  if (m.engines && typeof m.engines === "object") {
    const engines = m.engines as Record<string, unknown>
    if (engines.cognia && typeof engines.cognia !== "string") {
      pushError(
        "engines.cognia",
        "manifest.engines.cognia.invalid",
        'Invalid "engines.cognia" field'
      )
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

  // ── ADR-0026 lazy-factory fields ────────────────────────────────────────────
  // Each of the six new manifest blocks shares the `{ id, label, entry,
  // export }` shape. `validateLazyFactoryArray` enforces the shared rules;
  // the `extra` callback runs field-specific checks (e.g. `kind` for
  // aiProviders, `partType` for messageRenderers).

  validateLazyFactoryArray(m.ocrProviders, { field: "ocrProviders" }, pushError, pushWarning)
  validateLazyFactoryArray(
    m.workspaceBackends,
    { field: "workspaceBackends" },
    pushError,
    pushWarning
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
    pushWarning
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
    pushWarning
  )
  validateLazyFactoryArray(m.modalMounts, { field: "modalMounts" }, pushError, pushWarning)
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
    pushWarning
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
  const validTypes = ["string", "number", "boolean", "array", "object"]

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

  // Type check
  const actualType = Array.isArray(value) ? "array" : typeof value
  if (actualType !== schema.type) {
    errors.push({
      field: name,
      code: "invalid_type",
      message: `Config field "${name}" expected type "${schema.type}" but got "${actualType}"`,
    })
    return errors
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

  // Number validations
  if (schema.type === "number" && typeof value === "number") {
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
