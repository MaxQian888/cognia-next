#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const catalogPath = resolve(repoRoot, "packages/plugin-sdk/contract/catalog.json")
const catalogSchemaPath = resolve(repoRoot, "packages/plugin-sdk/contract/catalog.schema.json")
const rustPath = resolve(repoRoot, "crates/cognia-cli/src/generated_plugin_contract.rs")
const pythonPath = resolve(repoRoot, "plugin-sdk/python/src/cognia/_generated_contract.py")

export function readCatalog() {
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))
  const schema = JSON.parse(readFileSync(catalogSchemaPath, "utf8"))
  validateAgainstSchema(catalog, schema)
  return catalog
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

export function renderRustContract(catalog) {
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
pub(crate) const VALID_PERMISSIONS: &[&str] = &[\n${rustStrings(catalog.permissions)}\n];\n\n\
pub(crate) const VALID_CAPABILITIES: &[&str] = &[\n${rustStrings(
    catalog.capabilities.map((capability) => capability.id)
  )}\n];\n\n\
pub(crate) const CAPABILITY_MINIMUM_HOST_VERSIONS: &[(&str, &str)] = &[\n${capabilityMinimums}\n];\n\n\
pub(crate) const VALID_PLUGIN_TYPES: &[&str] =\n    &[${catalog.pluginTypes
    .map((pluginType) => JSON.stringify(pluginType))
    .join(", ")}];\n\n\
pub(crate) const CAPABILITY_FIELDS: &[(&str, &[&str])] = &[\n${capabilityFields}\n];\n\n\
pub(crate) const MANIFEST_CONTRIBUTIONS: &[\n    (&str, &[&str], &str, Option<&str>, Option<&str>, Option<&str>)\n] = &[\n${manifestContributions}\n];\n\n\
pub(crate) const RUNTIME_ENTRY_CONTRACTS: &[(&str, &[&str], Option<&str>, bool, &[&str])] = &[\n${runtimeEntries}\n];\n\n\
pub(crate) const PLUGIN_PATH_FIELDS: &[&str] = &[\n${rustStrings(
    catalog.pathFields.map((entry) => entry.path)
  )}\n];\n`)
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
MINIMUM_HOST_VERSION = ${JSON.stringify(catalog.minimumHostVersion)}\n\n\
VALID_PLUGIN_TYPES = (\n${pythonTuple(catalog.pluginTypes)}\n)\n\n\
VALID_PERMISSIONS = (\n${pythonTuple(catalog.permissions)}\n)\n\n\
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
PLUGIN_PATH_FIELDS = (\n${pythonTuple(catalog.pathFields.map((entry) => entry.path))}\n)\n`
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
  writeOrCheck(rustPath, renderRustContract(catalog), check)
  writeOrCheck(pythonPath, renderPythonContract(catalog), check)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    generate({ check: process.argv.includes("--check") })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
