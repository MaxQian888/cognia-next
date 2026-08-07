#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const catalogPath = resolve(repoRoot, "packages/plugin-sdk/contract/catalog.json")
const catalogSchemaPath = resolve(repoRoot, "packages/plugin-sdk/contract/catalog.schema.json")
const pluginPointCatalogPath = resolve(repoRoot, "packages/plugin-sdk/contract/plugin-points.json")
const pluginPointSchemaPath = resolve(
  repoRoot,
  "packages/plugin-sdk/contract/plugin-points.schema.json"
)
const pluginPointExporterPath = resolve(repoRoot, "scripts/plugin/export-plugin-points.mts")
const tsxCliPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs")
const prettierCliPath = resolve(repoRoot, "node_modules/prettier/bin/prettier.cjs")
const rustPath = resolve(repoRoot, "crates/cognia-cli/src/engine/contract.rs")
const pythonPath = resolve(repoRoot, "plugin-sdk/python/src/cognia/_generated_contract.py")
const typescriptPath = resolve(repoRoot, "packages/plugin-sdk/src/contracts/generated.ts")
const apiDocsPath = resolve(repoRoot, "docs/content/docs/plugin-dev/api-reference.generated.mdx")
const apiSurfaceBaselinePath = resolve(
  repoRoot,
  "packages/plugin-sdk/contract/api-surface-baseline.json"
)

export function validateApiSurfaceCompatibility(catalog, baseline) {
  const namespaces = new Map(catalog.apiNamespaces.map((namespace) => [namespace.id, namespace]))
  const errors = []
  for (const expected of baseline.namespaces) {
    const current = namespaces.get(expected.id)
    if (!current) {
      errors.push(`removed namespace ${expected.id}`)
      continue
    }
    if (current.authorPath !== expected.authorPath) {
      errors.push(`renamed public path ${expected.authorPath} to ${current.authorPath}`)
    }
    for (const runtime of expected.runtimes) {
      if (!current.runtimes.includes(runtime)) {
        errors.push(`removed runtime ${runtime} from ${expected.id}`)
      }
    }
    for (const platform of expected.platforms) {
      if (!current.platforms.includes(platform)) {
        errors.push(`removed platform ${platform} from ${expected.id}`)
      }
    }
    const methods = new Set(current.methods.map((method) => method.id))
    for (const method of expected.methods) {
      if (!methods.has(method)) errors.push(`removed method ${method}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `incompatible Plugin API surface:\n${errors.map((error) => `- ${error}`).join("\n")}`
    )
  }
  return catalog
}

export function validateInterfaceCatalog(catalog) {
  const permissions = new Set(catalog.permissions)
  const errorCodes = new Set(catalog.errorCodes ?? [])
  if (!Array.isArray(catalog.errorCodes) || catalog.errorCodes.length === 0) {
    throw new Error(`catalog.errorCodes must declare at least one code`)
  }
  if (errorCodes.size !== catalog.errorCodes.length) {
    throw new Error(`catalog.errorCodes contains duplicates`)
  }
  const namespaces = new Set()
  const methods = new Set()
  for (const namespace of catalog.apiNamespaces) {
    if (namespaces.has(namespace.id)) throw new Error(`duplicate API namespace ${namespace.id}`)
    namespaces.add(namespace.id)
    if (namespace.authorPath !== `ctx.${namespace.id}`) {
      throw new Error(`API namespace ${namespace.id} must use authorPath ctx.${namespace.id}`)
    }
    if (namespace.id !== "capabilities" && namespace.methods.length === 0) {
      throw new Error(`callable API namespace ${namespace.id} must declare its methods`)
    }
    for (const method of namespace.methods) {
      if (methods.has(method.id)) throw new Error(`duplicate API method ${method.id}`)
      methods.add(method.id)
      if (method.id !== `${namespace.id}.${method.name}`) {
        throw new Error(`API method ${method.id} must be namespaced by ${namespace.id}`)
      }
      for (const permission of method.requiredPermissions) {
        if (!permissions.has(permission)) {
          throw new Error(`API method ${method.id} uses unknown permission ${permission}`)
        }
      }
    }
  }
  return catalog
}

export function validatePluginPointCatalog(pointCatalog, permissions) {
  const seen = new Set()
  const validPermissions = new Set(permissions)
  for (const point of pointCatalog.pluginPoints) {
    if (seen.has(point.id)) throw new Error(`duplicate plugin point ${point.id}`)
    seen.add(point.id)
    if (point.kind === "ui-slot" && !point.formFactor) {
      throw new Error(`UI plugin point ${point.id} must declare formFactor`)
    }
    if (point.kind !== "ui-slot" && point.formFactor !== undefined) {
      throw new Error(`non-UI plugin point ${point.id} cannot declare formFactor`)
    }
    if (point.permission && !validPermissions.has(point.permission)) {
      throw new Error(`plugin point ${point.id} uses unknown permission ${point.permission}`)
    }
  }
  return pointCatalog
}

export function readPluginPointCatalog(permissions) {
  const result = spawnSync(process.execPath, [tsxCliPath, pluginPointExporterPath], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`plugin point export failed: ${result.stderr.trim()}`)
  }
  const pointCatalog = JSON.parse(result.stdout)
  const pointSchema = JSON.parse(readFileSync(pluginPointSchemaPath, "utf8"))
  validateAgainstSchema(pointCatalog, pointSchema, "pluginPointCatalog")
  return validatePluginPointCatalog(pointCatalog, permissions)
}

export function readCatalog() {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))
  const schema = JSON.parse(readFileSync(catalogSchemaPath, "utf8"))
  validateAgainstSchema(catalog, schema)
  const pointCatalog = readPluginPointCatalog(catalog.permissions)
  const hydratedCatalog = validateInterfaceCatalog({
    ...catalog,
    pluginPointSchemaVersion: pointCatalog.schemaVersion,
    pluginPoints: pointCatalog.pluginPoints,
  })
  const baseline = JSON.parse(readFileSync(apiSurfaceBaselinePath, "utf8"))
  return validateApiSurfaceCompatibility(hydratedCatalog, baseline)
}

function valueType(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (Number.isInteger(value)) return "integer"
  return typeof value
}

export function validateAgainstSchema(value, schema, path = "catalog") {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const actualType = valueType(value)
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.includes(actualType) &&
    !(actualType === "integer" && allowedTypes.includes("number"))
  ) {
    throw new Error(`${path} must be ${allowedTypes.join(" or ")}, got ${actualType}`)
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} must be one of ${schema.enum.map(String).join(", ")}`)
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`${path} must be at least ${schema.minimum}`)
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item))
      if (new Set(serialized).size !== serialized.length) {
        throw new Error(`${path} must contain unique items`)
      }
    }
    if (schema.items) {
      value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`))
    }
    return value
  }
  if (value && typeof value === "object") {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        throw new Error(`${path}.${required} is required by catalog.schema.json`)
      }
    }
    const properties = schema.properties ?? {}
    for (const [key, item] of Object.entries(value)) {
      const childSchema =
        properties[key] ??
        (schema.additionalProperties && typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : undefined)
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          throw new Error(`${path}.${key} is not allowed by catalog.schema.json`)
        }
        continue
      }
      validateAgainstSchema(item, childSchema, `${path}.${key}`)
    }
  }
  return value
}

function rustStrings(values) {
  return values.map((value) => `    ${JSON.stringify(value)},`).join("\n")
}

function rustRawString(value) {
  let hashes = "#"
  while (value.includes(`"${hashes}`)) hashes += "#"
  return `r${hashes}"${value}"${hashes}`
}

function formatRust(source) {
  const result = spawnSync("rustfmt", ["--emit", "stdout", "--edition", "2021"], {
    input: source,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`rustfmt failed while generating the Rust contract: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function formatPrettier(source, parser) {
  const result = spawnSync(process.execPath, [prettierCliPath, "--parser", parser], {
    input: source,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(
      `prettier failed while generating the Plugin API contract: ${result.stderr.trim()}`
    )
  }
  return result.stdout
}

export function renderRustContract(catalog) {
  const authoringCatalog = rustRawString(JSON.stringify(catalog))
  const capabilityMinimums = catalog.capabilities
    .map(
      (capability) =>
        `    (${JSON.stringify(capability.id)}, ${JSON.stringify(
          capability.minimumHostVersion ?? catalog.minimumHostVersion
        )}),`
    )
    .join("\n")
  const capabilityFields = catalog.capabilities
    .filter((capability) => capability.id !== "python" && capability.manifestFields.length > 0)
    .map(
      (capability) =>
        `    (${JSON.stringify(capability.id)}, &[${capability.manifestFields
          .map((field) => JSON.stringify(field))
          .join(", ")}]),`
    )
    .join("\n")
  const manifestContributions = catalog.manifestContributions
    .map(
      (entry) => `    (
        ${JSON.stringify(entry.field)},
        &[${entry.capabilities.map((capability) => JSON.stringify(capability)).join(", ")}],
        ${JSON.stringify(entry.execution)},
        ${entry.entryPath ? `Some(${JSON.stringify(entry.entryPath)})` : "None"},
        ${entry.javascriptWhen ? `Some(${JSON.stringify(entry.javascriptWhen.path)})` : "None"},
        ${
          entry.javascriptWhen?.equals
            ? `Some(${JSON.stringify(entry.javascriptWhen.equals)})`
            : "None"
        },
        ${JSON.stringify(entry.pythonExecution ?? "unsupported")},
    ),`
    )
    .join("\n")
  const runtimeEntries = Object.entries(catalog.runtimeEntries)
    .map(
      ([pluginType, entry]) => `    (
        ${JSON.stringify(pluginType)},
        &[${entry.required.map((field) => JSON.stringify(field)).join(", ")}],
        ${entry.javascriptEntry ? `Some(${JSON.stringify(entry.javascriptEntry)})` : "None"},
        ${entry.javascriptEntryRequiredForContributions},
        &[${(entry.requiredAnyOf ?? []).map((field) => JSON.stringify(field)).join(", ")}],
    ),`
    )
    .join("\n")
  return formatRust(`// @generated by scripts/plugin/generate-contract.mjs — do not edit.\n\
pub(crate) const CONTRACT_VERSION: &str = ${JSON.stringify(catalog.contractVersion)};\n\
pub(crate) const PROTOCOL_VERSION: &str = ${JSON.stringify(catalog.protocol.version)};\n\
pub(crate) const SDK_VERSION: &str = ${JSON.stringify(catalog.protocol.sdkVersion)};\n\
pub(crate) const MINIMUM_SDK_VERSION: &str = ${JSON.stringify(catalog.protocol.minimumSdkVersion)};\n\
pub(crate) const GATEWAY_CLIENT_VERSION: &str = ${JSON.stringify(catalog.protocol.gatewayClientVersion)};\n\
pub(crate) const MINIMUM_GATEWAY_CLIENT_VERSION: &str = ${JSON.stringify(catalog.protocol.minimumGatewayClientVersion)};\n\n\
pub(crate) const VALID_PERMISSIONS: &[&str] = &[\n${rustStrings(catalog.permissions)}\n];\n\n\
pub(crate) const VALID_ERROR_CODES: &[&str] = &[\n${rustStrings(catalog.errorCodes)}\n];\n\n\
pub(crate) const VALID_CAPABILITIES: &[&str] = &[\n${rustStrings(
    catalog.capabilities.map((capability) => capability.id)
  )}\n];\n\n\
pub(crate) const CAPABILITY_MINIMUM_HOST_VERSIONS: &[(&str, &str)] = &[\n${capabilityMinimums}\n];\n\n\
pub(crate) const VALID_PLUGIN_TYPES: &[&str] =\n    &[${catalog.pluginTypes
    .map((pluginType) => JSON.stringify(pluginType))
    .join(", ")}];\n\n\
pub(crate) const CAPABILITY_FIELDS: &[(&str, &[&str])] = &[\n${capabilityFields}\n];\n\n\
pub(crate) const MANIFEST_CONTRIBUTIONS: &[\n    (&str, &[&str], &str, Option<&str>, Option<&str>, Option<&str>, &str)\n] = &[\n${manifestContributions}\n];\n\n\
pub(crate) const RUNTIME_ENTRY_CONTRACTS: &[(&str, &[&str], Option<&str>, bool, &[&str])] = &[\n${runtimeEntries}\n];\n\n\
pub(crate) const PLUGIN_PATH_FIELDS: &[&str] = &[\n${rustStrings(
    catalog.pathFields.map((entry) => entry.path)
  )}\n];\n\n\
/// Complete canonical catalog used by read-only authoring queries.\n\
pub(crate) const AUTHORING_CATALOG_JSON: &str = ${authoringCatalog};\n`)
}

function pythonTuple(values) {
  return values.map((value) => `    ${JSON.stringify(value)},`).join("\n")
}

function pythonLiteral(value, indent = 0) {
  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const padding = " ".repeat(indent)
    const childPadding = " ".repeat(indent + 4)
    return `[\n${value
      .map((item) => `${childPadding}${pythonLiteral(item, indent + 4)},`)
      .join("\n")}\n${padding}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"
    const padding = " ".repeat(indent)
    const childPadding = " ".repeat(indent + 4)
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${childPadding}${JSON.stringify(key)}: ${pythonLiteral(item, indent + 4)},`
      )
      .join("\n")}\n${padding}}`
  }
  throw new TypeError(`Unsupported Python literal value: ${typeof value}`)
}

export function renderPythonContract(catalog) {
  const fields = Object.fromEntries(
    catalog.capabilities.map((capability) => [capability.id, capability.manifestFields])
  )
  const minimums = Object.fromEntries(
    catalog.capabilities.map((capability) => [
      capability.id,
      capability.minimumHostVersion ?? catalog.minimumHostVersion,
    ])
  )
  const support = Object.fromEntries(
    catalog.capabilities.map((capability) => [capability.id, capability.support])
  )
  const introductions = Object.fromEntries(
    catalog.capabilities.map((capability) => [capability.id, capability.introducedIn])
  )
  return `# @generated by scripts/plugin/generate-contract.mjs — do not edit.\n\
CATALOG_SCHEMA_VERSION = ${catalog.schemaVersion}\n\
CONTRACT_VERSION = ${JSON.stringify(catalog.contractVersion)}\n\
PROTOCOL_VERSION = ${JSON.stringify(catalog.protocol.version)}\n\
SDK_VERSION = ${JSON.stringify(catalog.protocol.sdkVersion)}\n\
MINIMUM_SDK_VERSION = ${JSON.stringify(catalog.protocol.minimumSdkVersion)}\n\
GATEWAY_CLIENT_VERSION = ${JSON.stringify(catalog.protocol.gatewayClientVersion)}\n\
MINIMUM_GATEWAY_CLIENT_VERSION = ${JSON.stringify(catalog.protocol.minimumGatewayClientVersion)}\n\
LEGACY_ADAPTER_ENABLED = ${catalog.protocol.legacyAdapter ? "True" : "False"}\n\
MINIMUM_HOST_VERSION = ${JSON.stringify(catalog.minimumHostVersion)}\n\n\
VALID_PLUGIN_TYPES = (\n${pythonTuple(catalog.pluginTypes)}\n)\n\n\
VALID_PERMISSIONS = (\n${pythonTuple(catalog.permissions)}\n)\n\n\
VALID_ERROR_CODES = (\n${pythonTuple(catalog.errorCodes)}\n)\n\n\
VALID_CAPABILITIES = (\n${pythonTuple(
    catalog.capabilities.map((capability) => capability.id)
  )}\n)\n\n\
CAPABILITY_FIELDS = ${pythonLiteral(fields)}\n\n\
CAPABILITY_SUPPORT = ${pythonLiteral(support)}\n\n\
CAPABILITY_INTRODUCED_VERSIONS = ${pythonLiteral(introductions)}\n\n\
CAPABILITY_MINIMUM_HOST_VERSIONS = ${pythonLiteral(minimums)}\n\n\
MANIFEST_CONTRIBUTIONS = ${pythonLiteral(catalog.manifestContributions)}\n\n\
RUNTIME_ENTRY_CONTRACTS = ${pythonLiteral(catalog.runtimeEntries)}\n\n\
PLUGIN_PATH_FIELD_CONTRACTS = ${pythonLiteral(catalog.pathFields)}\n\n\
PLUGIN_POINT_SCHEMA_VERSION = ${catalog.pluginPointSchemaVersion}\n\n\
PLUGIN_POINT_CONTRACTS = ${pythonLiteral(catalog.pluginPoints)}\n\n\
API_NAMESPACE_CONTRACTS = ${pythonLiteral(catalog.apiNamespaces)}\n\n\
PLUGIN_PATH_FIELDS = (\n${pythonTuple(catalog.pathFields.map((entry) => entry.path))}\n)\n`
}

export function renderTypeScriptContract(catalog) {
  return formatPrettier(
    `// @generated by scripts/plugin/generate-contract.mjs — do not edit.\n\nexport const PLUGIN_CONTRACT_VERSION = ${JSON.stringify(catalog.contractVersion)} as const\nexport const PLUGIN_PROTOCOL_VERSION = ${JSON.stringify(catalog.protocol.version)} as const\nexport const PLUGIN_SDK_VERSION = ${JSON.stringify(catalog.protocol.sdkVersion)} as const\nexport const PLUGIN_MINIMUM_SDK_VERSION = ${JSON.stringify(catalog.protocol.minimumSdkVersion)} as const\nexport const PLUGIN_GATEWAY_CLIENT_VERSION = ${JSON.stringify(catalog.protocol.gatewayClientVersion)} as const\nexport const PLUGIN_MINIMUM_GATEWAY_CLIENT_VERSION = ${JSON.stringify(catalog.protocol.minimumGatewayClientVersion)} as const\nexport const CANONICAL_PLUGIN_PERMISSION_IDS = ${JSON.stringify(catalog.permissions, null, 2)} as const\nexport type CanonicalPluginPermission = (typeof CANONICAL_PLUGIN_PERMISSION_IDS)[number]\nexport const CANONICAL_PLUGIN_ERROR_CODES = ${JSON.stringify(catalog.errorCodes, null, 2)} as const\nexport type CanonicalPluginErrorCode = (typeof CANONICAL_PLUGIN_ERROR_CODES)[number]\n`,
    "typescript"
  )
}

export function renderApiReference(catalog) {
  const rows = catalog.apiNamespaces
    .map((namespace) => {
      const permissions = new Set(namespace.methods.flatMap((method) => method.requiredPermissions))
      return `| \`${namespace.authorPath}\` | ${namespace.methods.length} | ${
        [...permissions].map((permission) => `\`${permission}\``).join(", ") || "None"
      } | ${namespace.runtimes.join(", ")} | ${namespace.dataClassification} |`
    })
    .join("\n")
  const details = catalog.apiNamespaces
    .filter((namespace) => namespace.methods.length > 0)
    .map(
      (namespace) =>
        `## \`${namespace.authorPath}\`\n\n| Method | Permissions | Risk | Idempotent |\n| --- | --- | --- | --- |\n${namespace.methods
          .map(
            (method) =>
              `| \`${method.id}\` | ${method.requiredPermissions.map((permission) => `\`${permission}\``).join(", ") || "None"} | ${method.risk} | ${method.idempotent ? "Yes" : "No"} |`
          )
          .join("\n")}`
    )
    .join("\n\n")
  const errorRows = catalog.errorCodes.map((code) => `| \`${code}\` |`).join("\n")
  return `---\ntitle: Generated Plugin API Reference\ndescription: Generated from the canonical Plugin Interface Catalog.\n---\n\n{/* Generated by scripts/plugin/generate-contract.mjs — do not edit. */}\n\n# Plugin API Reference\n\nContract \`${catalog.contractVersion}\`; protocol \`${catalog.protocol.version}\`. The public author surface is \`ctx.*\`. Runtime enforcement remains fail-closed for unmapped methods.\n\n| Namespace | Methods | Declared permissions | Runtimes | Data class |\n| --- | ---: | --- | --- | --- |\n${rows}\n\n## Adapter error codes\n\nCanonical error-code taxonomy raised by adapter runtimes (CLI tools, OpenAPI integrations, managed processes, desktop automation sessions). Author-facing surface: \`PluginAdapterError\` from \`@cognia/plugin-sdk\`.\n\n| Code |\n| --- |\n${errorRows}\n\n${details}\n`
}

function writeOrCheck(path, content, check) {
  if (check) {
    const current = readFileSync(path, "utf8")
    if (current !== content) {
      throw new Error(
        `${relative(repoRoot, path)} is stale; run node scripts/plugin/generate-contract.mjs`
      )
    }
    return
  }
  writeFileSync(path, content)
}

export function generate({ check = false } = {}) {
  const catalog = readCatalog()
  writeOrCheck(
    pluginPointCatalogPath,
    formatPrettier(
      JSON.stringify(
        {
          schemaVersion: catalog.pluginPointSchemaVersion,
          pluginPoints: catalog.pluginPoints,
        },
        null,
        2
      ),
      "json"
    ),
    check
  )
  writeOrCheck(rustPath, renderRustContract(catalog), check)
  writeOrCheck(pythonPath, renderPythonContract(catalog), check)
  writeOrCheck(typescriptPath, renderTypeScriptContract(catalog), check)
  writeOrCheck(apiDocsPath, renderApiReference(catalog), check)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    generate({ check: process.argv.includes("--check") })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
