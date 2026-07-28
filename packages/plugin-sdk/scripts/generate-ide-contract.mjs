import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { format, resolveConfig } from "prettier"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(root, "../..")
const catalogPath = resolve(root, "contract/code-1.128-ide.json")
const upstreamInventoryPath = resolve(root, "contract/code-1.128-upstream-extension-points.json")
const upstreamProviderInventoryPath = resolve(
  root,
  "contract/code-1.128-upstream-provider-apis.json"
)
const contributionSchemasPath = resolve(root, "contract/code-1.128-contribution-schemas.json")
const check = process.argv.includes("--check")
const source = JSON.parse(await readFile(catalogPath, "utf8"))
const upstreamInventory = JSON.parse(await readFile(upstreamInventoryPath, "utf8"))
const upstreamProviderInventory = JSON.parse(await readFile(upstreamProviderInventoryPath, "utf8"))
const contributionSchemas = JSON.parse(await readFile(contributionSchemasPath, "utf8"))
validateUpstreamClassification(source, upstreamInventory)
validateUpstreamProviderClassification(source, upstreamProviderInventory)
validateContributionSchemas(source, upstreamInventory, contributionSchemas)
const contributionSchemaHash = `sha256:${createHash("sha256")
  .update(canonicalJson(contributionSchemas))
  .digest("hex")}`
const catalogHash = `sha256:${createHash("sha256")
  .update(
    canonicalJson({
      ...source,
      catalogHash: undefined,
      contributionSchemaHash,
    })
  )
  .digest("hex")}`
const catalog = { ...source, contributionSchemaHash, catalogHash }
const brokerProtocolPath = resolve(repositoryRoot, "src-tauri/src/codeserver/broker_protocol.rs")
const brokerExtensionPath = resolve(
  repositoryRoot,
  "sidecar/codeserver-agent-ext/src/extension.mjs"
)
const brokerProtocolSource = await readFile(brokerProtocolPath, "utf8")
const brokerExtensionSource = await readFile(brokerExtensionPath, "utf8")
const prettierConfig = (await resolveConfig(resolve(repositoryRoot, "package.json"))) ?? {}
const formatGeneratedJson = (value) =>
  format(JSON.stringify(value), { ...prettierConfig, parser: "json" })
const formatGeneratedTypeScript = (value) =>
  format(value, { ...prettierConfig, parser: "typescript" })

const outputs = new Map([
  [catalogPath, await formatGeneratedJson(catalog)],
  [
    resolve(root, "contract/ide-manifest.schema.json"),
    await formatGeneratedJson(schema(catalog, contributionSchemas)),
  ],
  [
    resolve(root, "contract/ide-conformance-fixtures.json"),
    await formatGeneratedJson(fixtures(catalog, upstreamInventory, upstreamProviderInventory)),
  ],
  [resolve(root, "src/ide/generated.ts"), await formatGeneratedTypeScript(generatedTypes(catalog))],
  [
    brokerProtocolPath,
    replaceCatalogHash(
      brokerProtocolSource,
      /(DEFAULT_CATALOG_HASH:\s*&str\s*=\s*\n?\s*)"sha256:[a-f0-9]{64}"/,
      catalogHash
    ),
  ],
  [
    brokerExtensionPath,
    replaceCatalogHash(
      brokerExtensionSource,
      /(IDE_CATALOG_HASH\s*=\s*)"sha256:[a-f0-9]{64}"/,
      catalogHash
    ),
  ],
])

let changed = false
for (const [path, contents] of outputs) {
  const current = await readFile(path, "utf8").catch(() => "")
  if (current === contents) continue
  changed = true
  if (check) console.error(`IDE contract artifact is stale: ${path}`)
  else {
    await writeFile(path, contents)
    console.log(`generated ${path}`)
  }
}
if (check && changed) process.exitCode = 1

function schema(catalog, contributionSchemas) {
  const codeSchemaDefinitions = buildCodeSchemaDefinitions(contributionSchemas)
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://cognia.dev/schemas/plugin-ide-1.json",
    title: "Cognia Managed IDE Manifest",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "targets"],
    properties: {
      schemaVersion: { const: 1 },
      targets: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { enum: ["monaco", "pro-ide"] },
      },
      requirements: {
        type: "object",
        additionalProperties: false,
        properties: {
          codeApiVersion: { const: catalog.codeApiVersion },
          brokerProtocol: { const: "^1.0.0" },
          capabilities: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
      contributions: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          catalog.contributions.map((key) => [
            key,
            combineContributionSchemas(
              rewriteSchemaReferences(
                contributionSchemas.contributions[key],
                "#/$defs/codeExtensionRegistry",
                codeSchemaDefinitions.referenceNames
              ),
              proposalExclusionSchema(key)
            ),
          ])
        ),
      },
      providers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "handler"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
            kind: { enum: catalog.providers.map((entry) => entry.kind) },
            selector: {},
            handler: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" },
            permission: { type: "string" },
            proIdeOnly: { type: "boolean" },
            metadata: { type: "object" },
          },
        },
      },
      executables: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "source"],
          properties: {
            id: { type: "string", minLength: 1 },
            source: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "path", "sha256"],
                  properties: {
                    kind: { const: "plugin-resource" },
                    path: { type: "string", minLength: 1 },
                    sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "tool"],
                  properties: {
                    kind: { const: "registered-tool" },
                    tool: { type: "string", minLength: 1 },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "setting"],
                  properties: {
                    kind: { const: "user-selected" },
                    setting: { type: "string", minLength: 1 },
                  },
                },
              ],
            },
            args: { type: "array", items: { type: "string" } },
            allowedEnvironment: { type: "array", items: { type: "string" } },
            workingDirectory: { enum: ["workspace", "plugin-data"] },
            timeoutMs: { type: "integer", minimum: 1 },
            memoryLimitMb: { type: "integer", minimum: 1 },
          },
        },
      },
      protocols: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          ["lsp", "dap", "mcp"].map((family) => [
            family,
            { type: "array", items: { $ref: "#/$defs/protocolServer" } },
          ])
        ),
      },
      agents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "agentId", "name"],
          properties: {
            id: { type: "string", minLength: 1 },
            agentId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            commands: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "description"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    $defs: {
      ...codeSchemaDefinitions.schemas,
      protocolServer: {
        type: "object",
        additionalProperties: false,
        required: ["id", "executable", "transport"],
        properties: {
          id: { type: "string", minLength: 1 },
          executable: { type: "string", minLength: 1 },
          transport: { enum: ["stdio", "socket", "http", "sse"] },
          endpoint: { type: "string", format: "uri" },
          languages: { type: "array", items: { type: "string" } },
          initializationOptions: {},
        },
        allOf: [
          {
            if: {
              properties: { transport: { enum: ["socket", "http", "sse"] } },
              required: ["transport"],
            },
            then: { required: ["endpoint"] },
          },
        ],
      },
    },
  }
}

function proposalExclusionSchema(key) {
  const forbidFields = (...fields) => ({
    not: { anyOf: fields.map((field) => ({ required: [field] })) },
  })
  switch (key) {
    case "viewsWelcome":
      return { type: "array", items: { type: "object", ...forbidFields("group") } }
    case "terminal":
      return { type: "object", ...forbidFields("completionProviders") }
    case "chatParticipants":
      return {
        type: "array",
        items: {
          type: "object",
          ...forbidFields("isDefault", "modes", "locations"),
        },
      }
    case "customEditors":
      return {
        type: "array",
        items: {
          type: "object",
          properties: {
            priority: { type: "string", enum: ["default", "option"] },
          },
        },
      }
    case "resourceLabelFormatters":
      return {
        type: "array",
        items: {
          type: "object",
          properties: {
            formatting: {
              type: "object",
              ...forbidFields("workspaceTooltip"),
            },
          },
        },
      }
    case "languageModelTools":
      return {
        type: "array",
        items: {
          type: "object",
          ...forbidFields("legacyToolReferenceFullNames"),
        },
      }
    case "viewsContainers":
      return { type: "object", ...forbidFields("remote", "agentSessions") }
    case "views":
      return {
        type: "object",
        additionalProperties: {
          type: "array",
          items: { type: "object", ...forbidFields("accessibilityHelpContent") },
        },
      }
    case "configuration": {
      const configuration = {
        type: "object",
        properties: {
          properties: {
            type: "object",
            additionalProperties: {
              type: "object",
              ...forbidFields("agentsWindow"),
            },
          },
        },
      }
      return { oneOf: [configuration, { type: "array", items: configuration }] }
    }
    default:
      return undefined
  }
}

function combineContributionSchemas(upstream, exclusion) {
  return exclusion ? { allOf: [upstream, exclusion] } : upstream
}

function buildCodeSchemaDefinitions(locked) {
  const referenceNames = new Map([
    ["vscode://schemas/toolsParameters", "codeReferenceToolsParameters"],
    ["vscode://schemas/settings/configurationDefaults", "codeReferenceConfigurationDefaults"],
    ["vscode://schemas/settings/resourceLanguage", "codeReferenceResourceLanguage"],
    ["vscode://schemas/workbench-colors", "codeReferenceWorkbenchColors"],
    ["vscode://schemas/textmate-colors", "codeReferenceTextmateColors"],
    ["vscode://schemas/token-styling", "codeReferenceTokenStyling"],
    ["http://json-schema.org/draft-07/schema", "codeReferenceDraft07"],
  ])
  const schemas = {
    codeExtensionRegistry: {
      $defs: rewriteSchemaReferences(
        locked.definitions,
        "#/$defs/codeExtensionRegistry",
        referenceNames
      ),
    },
  }
  for (const [uri, sourceSchema] of Object.entries(locked.referencedSchemas)) {
    const normalizedUri = uri.endsWith("#") ? uri.slice(0, -1) : uri
    const name = referenceNames.get(normalizedUri)
    if (!name) {
      throw new Error(`Locked Code schema contains an unclassified reference URI: ${uri}`)
    }
    const { $id: _id, $schema: _schema, ...embeddedSchema } = sourceSchema
    schemas[name] = rewriteSchemaReferences(embeddedSchema, `#/$defs/${name}`, referenceNames)
  }
  return { referenceNames, schemas }
}

function rewriteSchemaReferences(value, localRoot, referenceNames) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteSchemaReferences(entry, localRoot, referenceNames))
  }
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value.enum) && value.enum.length === 0) {
    const { enum: _emptyEnum, ...annotations } = value
    return {
      ...rewriteSchemaReferences(annotations, localRoot, referenceNames),
      not: {},
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key !== "$ref" || typeof entry !== "string") {
        return [key, rewriteSchemaReferences(entry, localRoot, referenceNames)]
      }
      if (entry === "#" || entry.startsWith("#/")) {
        return [key, `${localRoot}${entry.slice(1)}`]
      }
      const hashIndex = entry.indexOf("#")
      const baseUri = hashIndex === -1 ? entry : entry.slice(0, hashIndex)
      const fragment = hashIndex === -1 ? "" : entry.slice(hashIndex + 1)
      const referenceName = referenceNames.get(baseUri)
      if (!referenceName) {
        throw new Error(`Locked Code schema contains an unresolved reference: ${entry}`)
      }
      return [key, `#/$defs/${referenceName}${fragment}`]
    })
  )
}

function fixtures(catalog, upstreamInventory, upstreamProviderInventory) {
  return {
    schemaVersion: 1,
    catalogHash: catalog.catalogHash,
    contributions: Object.fromEntries(
      catalog.contributions.map((key) => [key, { classified: true }])
    ),
    providers: Object.fromEntries(
      catalog.providers.map((entry) => [
        entry.kind,
        { permission: entry.permission, targets: entry.targets, classified: true },
      ])
    ),
    exclusions: Object.fromEntries(catalog.exclusions.map((entry) => [entry.id, entry.code])),
    upstreamExtensionPoints: Object.fromEntries(
      upstreamInventory.extensionPoints.map((entry) => [
        entry.id,
        entry.classification === "supported"
          ? { classification: "supported" }
          : { classification: "excluded", exclusion: entry.exclusion },
      ])
    ),
    upstreamProviderApis: Object.fromEntries(
      upstreamProviderInventory.providerApis.map((entry) => [
        entry.api,
        entry.classification === "supported"
          ? { classification: "supported", providerKind: entry.providerKind }
          : {
              classification: "excluded",
              providerKind: entry.providerKind,
              exclusion: entry.exclusion,
            },
      ])
    ),
  }
}

function validateUpstreamClassification(catalog, inventory) {
  if (inventory?.source?.tag !== catalog.codeApiVersion) {
    throw new Error(
      `IDE upstream inventory tag ${inventory?.source?.tag ?? "<missing>"} does not match ${catalog.codeApiVersion}`
    )
  }
  if (!Array.isArray(inventory.extensionPoints) || inventory.extensionPoints.length === 0) {
    throw new Error("IDE upstream inventory has no extension points")
  }
  const entries = new Map()
  for (const entry of inventory.extensionPoints) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !["supported", "excluded"].includes(entry.classification)
    ) {
      throw new Error(`IDE upstream inventory contains an invalid entry: ${JSON.stringify(entry)}`)
    }
    if (entries.has(entry.id)) {
      throw new Error(`IDE upstream inventory contains duplicate extension point: ${entry.id}`)
    }
    entries.set(entry.id, entry)
  }
  const catalogContributions = new Set(catalog.contributions)
  for (const contribution of catalogContributions) {
    const entry = entries.get(contribution)
    if (entry?.classification !== "supported") {
      throw new Error(`Stable Code contribution is not classified as supported: ${contribution}`)
    }
  }
  for (const entry of entries.values()) {
    if (entry.classification === "supported" && !catalogContributions.has(entry.id)) {
      throw new Error(`Supported Code contribution is absent from the catalog: ${entry.id}`)
    }
    if (entry.classification === "excluded") {
      if (typeof entry.exclusion !== "string") {
        throw new Error(`Excluded Code contribution has no exclusion category: ${entry.id}`)
      }
      if (!catalog.exclusions.some((exclusion) => exclusion.id === entry.exclusion)) {
        throw new Error(
          `Code contribution ${entry.id} references unknown exclusion: ${entry.exclusion}`
        )
      }
    }
  }
}

function validateUpstreamProviderClassification(catalog, inventory) {
  if (inventory?.source?.tag !== catalog.codeApiVersion) {
    throw new Error(
      `IDE upstream provider inventory tag ${inventory?.source?.tag ?? "<missing>"} does not match ${catalog.codeApiVersion}`
    )
  }
  if (
    typeof inventory?.source?.stableDtsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(inventory.source.stableDtsSha256)
  ) {
    throw new Error("IDE upstream provider inventory has no locked stable d.ts digest")
  }
  if (!Array.isArray(inventory.providerApis) || inventory.providerApis.length === 0) {
    throw new Error("IDE upstream provider inventory has no provider APIs")
  }
  const catalogProviders = new Set(catalog.providers.map((entry) => entry.kind))
  const coveredProviders = new Set()
  const apis = new Set()
  for (const entry of inventory.providerApis) {
    if (
      !entry ||
      typeof entry.api !== "string" ||
      typeof entry.providerKind !== "string" ||
      !["supported", "excluded"].includes(entry.classification)
    ) {
      throw new Error(
        `IDE upstream provider inventory contains an invalid entry: ${JSON.stringify(entry)}`
      )
    }
    if (apis.has(entry.api)) {
      throw new Error(`IDE upstream provider inventory contains duplicate API: ${entry.api}`)
    }
    apis.add(entry.api)
    if (entry.classification === "supported") {
      if (!catalogProviders.has(entry.providerKind)) {
        throw new Error(
          `Supported Code provider API maps to an absent provider kind: ${entry.api} -> ${entry.providerKind}`
        )
      }
      coveredProviders.add(entry.providerKind)
      continue
    }
    if (typeof entry.exclusion !== "string") {
      throw new Error(`Excluded Code provider API has no exclusion category: ${entry.api}`)
    }
    if (!catalog.exclusions.some((exclusion) => exclusion.id === entry.exclusion)) {
      throw new Error(
        `Code provider API ${entry.api} references unknown exclusion: ${entry.exclusion}`
      )
    }
  }
  for (const provider of catalogProviders) {
    if (!coveredProviders.has(provider)) {
      throw new Error(`Catalog provider has no locked stable Code API: ${provider}`)
    }
  }
}

function validateContributionSchemas(catalog, inventory, locked) {
  if (locked?.schemaVersion !== 1) {
    throw new Error("Locked Code contribution schemas have an unsupported schemaVersion")
  }
  if (locked?.source?.codeVersion !== catalog.codeApiVersion) {
    throw new Error(
      `Locked Code contribution schema version ${locked?.source?.codeVersion ?? "<missing>"} does not match ${catalog.codeApiVersion}`
    )
  }
  if (locked?.source?.codeServerVersion !== "4.128.0") {
    throw new Error("Locked Code contribution schemas were not extracted from code-server 4.128.0")
  }
  if (locked?.source?.extraction !== "live-code-server-schema-registry") {
    throw new Error("Locked Code contribution schemas have unknown provenance")
  }
  if (
    !locked?.contributions ||
    typeof locked.contributions !== "object" ||
    !locked?.definitions ||
    typeof locked.definitions !== "object" ||
    !locked?.referencedSchemas ||
    typeof locked.referencedSchemas !== "object"
  ) {
    throw new Error("Locked Code contribution schema artifact is incomplete")
  }
  const classified = new Set(inventory.extensionPoints.map((entry) => entry.id))
  const schemaKeys = new Set(Object.keys(locked.contributions))
  for (const id of classified) {
    if (!schemaKeys.has(id)) {
      throw new Error(`Classified Code contribution has no locked schema: ${id}`)
    }
  }
  for (const id of schemaKeys) {
    if (!classified.has(id)) {
      throw new Error(`Locked Code contribution schema is unclassified: ${id}`)
    }
  }
  for (const id of catalog.contributions) {
    const schema = locked.contributions[id]
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`Supported Code contribution has an invalid locked schema: ${id}`)
    }
  }
  for (const [id, metadata] of Object.entries(locked.source.schemas ?? {})) {
    if (
      !metadata ||
      typeof metadata.uri !== "string" ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)
    ) {
      throw new Error(`Locked Code schema source metadata is invalid: ${id}`)
    }
  }
}

function generatedTypes(catalog) {
  const contributionUnion = catalog.contributions.map(JSON.stringify).join("\n  | ")
  const providerUnion = catalog.providers.map((entry) => JSON.stringify(entry.kind)).join("\n  | ")
  return `// Generated by scripts/generate-ide-contract.mjs. Do not edit.
export const CODE_API_VERSION = ${JSON.stringify(catalog.codeApiVersion)} as const
export const BROKER_PROTOCOL_VERSION = ${JSON.stringify(catalog.brokerProtocol)} as const
export const IDE_CATALOG_HASH = ${JSON.stringify(catalog.catalogHash)} as const

export type Code128ContributionKey =
  | ${contributionUnion}

export type Code128ProviderKind =
  | ${providerUnion}
`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function replaceCatalogHash(source, pattern, hash) {
  if (!pattern.test(source)) {
    throw new Error(`Unable to locate generated IDE catalog hash in source`)
  }
  return source.replace(pattern, `$1${JSON.stringify(hash)}`)
}
