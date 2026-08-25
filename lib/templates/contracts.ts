import { sha256Hex } from "@/lib/share/hash"
import { tokenize } from "@/lib/workflow/runtime/expression"

export const TEMPLATE_API_VERSION = "cognia.ai/templates/v1" as const

export const TEMPLATE_FULL_DOMAINS = [
  "agentTeam",
  "workflow",
  "subagent",
  "customMode",
  "character",
  "skill",
] as const

export const TEMPLATE_CATALOG_ONLY_DOMAINS = [
  "a2ui",
  "goal",
  "scheduler",
  "prompt",
  "subscription",
  "document",
] as const

export type TemplateDomain =
  (typeof TEMPLATE_FULL_DOMAINS)[number] | (typeof TEMPLATE_CATALOG_ONLY_DOMAINS)[number]

export type TemplatePlatform = "desktop" | "web" | "mobile"
export type TemplateStatus =
  "draft" | "conflict" | "published" | "deprecated" | "yanked" | "tombstone"
export type TemplateTrust = "built-in" | "verified-publisher" | "signed-unknown" | "unsigned"

export type TemplateJson =
  null | boolean | number | string | TemplateJson[] | { [key: string]: TemplateJson }

export interface TemplateMetadata {
  name: string
  description?: string
  localized?: Record<string, { name: string; description?: string }>
  tags?: string[]
  category?: string
  author?: string
  icon?: string
}

interface TemplateInputBase {
  id: string
  label: string
  description?: string
  required: boolean
}

export type TemplateInputSpec =
  | (TemplateInputBase & {
      kind: "string" | "number" | "boolean"
      defaultValue?: string | number | boolean
    })
  | (TemplateInputBase & {
      kind: "enum"
      options: string[]
      defaultValue?: string
    })
  | (TemplateInputBase & {
      kind:
        | "resource"
        | "secretRef"
        | "twinSlot"
        | "model"
        | "provider"
        | "tool"
        | "skill"
        | "character"
        | "workflow"
      resourceKind?: string
      selector?: {
        allowMultiple?: boolean
        capability?: string
        localOnly?: boolean
      }
    })

export interface TemplateDependency {
  id: string
  kind: "template" | "plugin" | "skill" | "tool" | "model" | "provider" | "connector"
  requirement: "required" | "optional"
  version?: string
  fallback?: "omit" | "default"
  defaultValue?: TemplateJson
}

export interface TemplateCompatibility {
  platforms: TemplatePlatform[]
  minHostVersion?: string
  maxHostVersion?: string
}

export interface TemplateProvenance {
  source: "built-in" | "user" | "plugin" | "marketplace" | "file" | "link" | "legacy"
  packageId?: string
  pluginId?: string
  publisher?: string
  sourceUrl?: string
  trust?: TemplateTrust
  signatureFingerprint?: string
}

export interface TemplateDefinitionEnvelope<TPayload extends TemplateJson = TemplateJson> {
  apiVersion: typeof TEMPLATE_API_VERSION
  id: string
  domain: TemplateDomain
  status: TemplateStatus
  revision: number
  version: string | null
  metadata: TemplateMetadata
  payload: TPayload
  inputs: TemplateInputSpec[]
  dependencies: TemplateDependency[]
  capabilities: string[]
  compatibility: TemplateCompatibility
  provenance: TemplateProvenance
  contentHash: string
  baselineHash?: string
  createdAt: number
  updatedAt: number
}

export type TemplateDefinitionDraft<TPayload extends TemplateJson = TemplateJson> = Omit<
  TemplateDefinitionEnvelope<TPayload>,
  "apiVersion" | "contentHash" | "version" | "createdAt" | "updatedAt"
> & {
  apiVersion?: typeof TEMPLATE_API_VERSION
  contentHash?: string
  version?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface TemplateValidationIssue {
  code: string
  path: string
  message: string
  severity: "error" | "warning"
}

export interface TemplateValidationResult {
  ok: boolean
  issues: TemplateValidationIssue[]
}

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/i

/**
 * Whether `value` may be a template input id.
 *
 * Exported so an authoring surface can refuse a name BEFORE the save bounces:
 * the Studio offers to declare the undeclared tokens it finds in a payload, and
 * an offer that produces an `input.id` error is worse than no offer.
 */
export function isTemplateInputId(value: string): boolean {
  return IDENTIFIER.test(value)
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const FORBIDDEN_PRIVATE_KEYS = new Set([
  "twinId",
  "knowledgeTwinIds",
  "memoryIds",
  "privateMemories",
])
/**
 * Credential-bearing key *stems*, matched against the end of a normalised key.
 *
 * Exact-set matching is what let `defaultApiKey` through: `AgentTeamConfig`
 * carries one, the set held only the bare `apiKey`, and the same bare-key check
 * backs both this validator and `NON_PORTABLE_KEYS` in `adapters.ts` — so the
 * field was neither stripped on projection nor flagged on validation, and rode
 * a published template to another device in clear text.
 *
 * Suffix matching, not substring: the repo is full of innocent
 * `budgetTokens` / `cacheCreationInputTokens` / `maxThinkingTokens` /
 * `cacheKey` / `bindingKey` fields, so `token` and `key` are never stems on
 * their own. Every stem below is unambiguous at the end of a key; the plural
 * forms are spelled out rather than derived, because stripping a trailing `s`
 * would turn `maxTokens` into a false positive.
 */
const CREDENTIAL_KEY_STEMS = [
  "apikey",
  "apikeys",
  "apitoken",
  "accesskey",
  "accesskeys",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "bottoken",
  "apptoken",
  "appkey",
  "clientsecret",
  "webhooksecret",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "credentialid",
  "credentialref",
  "password",
  "passphrase",
  "privatekey",
]

/**
 * The generic names, which are credentials on their own but far too common as
 * a suffix to match that way (`maxTokens`, `cacheKey`, …).
 */
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "apiKey",
  "token",
  "secret",
  "credentialId",
  "subscriptionId",
])

/**
 * Whether an object key carries a credential and therefore may never be
 * packaged. Shared with `stripNonPortable` in `adapters.ts` so the strip list
 * and the validator can no longer disagree about what a secret looks like.
 */
export function isCredentialKey(key: string): boolean {
  if (FORBIDDEN_CREDENTIAL_KEYS.has(key)) return true
  const normalized = key.toLowerCase().replace(/[_-]/g, "")
  return CREDENTIAL_KEY_STEMS.some((stem) => normalized.endsWith(stem))
}
const FORBIDDEN_PATH_KEYS = new Set(["localPath", "tauriPath", "absolutePath"])

function canonicalize(value: TemplateJson): TemplateJson {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  )
}

export function canonicalTemplateStringify(value: TemplateJson): string {
  return JSON.stringify(canonicalize(value))
}

function hashableDefinition(
  definition: Omit<TemplateDefinitionEnvelope, "contentHash" | "createdAt" | "updatedAt">
): TemplateJson {
  return {
    apiVersion: definition.apiVersion,
    id: definition.id,
    domain: definition.domain,
    version: definition.version,
    metadata: definition.metadata as unknown as TemplateJson,
    payload: definition.payload,
    inputs: definition.inputs as unknown as TemplateJson,
    dependencies: definition.dependencies as unknown as TemplateJson,
    capabilities: definition.capabilities,
    compatibility: definition.compatibility as unknown as TemplateJson,
  }
}

export async function createTemplateDefinition<TPayload extends TemplateJson>(
  draft: TemplateDefinitionDraft<TPayload>
): Promise<TemplateDefinitionEnvelope<TPayload>> {
  const now = Date.now()
  const withoutHash = {
    ...draft,
    apiVersion: TEMPLATE_API_VERSION,
    version: draft.version ?? null,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
  }
  const contentHash = await sha256Hex(
    canonicalTemplateStringify(
      hashableDefinition(withoutHash as Omit<TemplateDefinitionEnvelope, "contentHash">)
    )
  )
  return { ...withoutHash, contentHash } as TemplateDefinitionEnvelope<TPayload>
}

export async function verifyTemplateDefinitionHash(
  definition: TemplateDefinitionEnvelope
): Promise<boolean> {
  const { contentHash, createdAt: _createdAt, updatedAt: _updatedAt, ...hashable } = definition
  const actual = await sha256Hex(
    canonicalTemplateStringify(
      hashableDefinition(
        hashable as Omit<TemplateDefinitionEnvelope, "contentHash" | "createdAt" | "updatedAt">
      )
    )
  )
  return actual === contentHash
}

function pushForbiddenPayloadIssues(
  value: TemplateJson,
  path: string,
  issues: TemplateValidationIssue[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => pushForbiddenPayloadIssues(item, `${path}[${index}]`, issues))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`
    if (FORBIDDEN_PRIVATE_KEYS.has(key)) {
      issues.push({
        code: "portable.private-field",
        path: nestedPath,
        message: `${key} is device-private and must be represented by a portable role slot`,
        severity: "error",
      })
    }
    if (isCredentialKey(key)) {
      issues.push({
        code: "portable.credential-field",
        path: nestedPath,
        message: `${key} must be represented by a secret reference slot`,
        severity: "error",
      })
    }
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      issues.push({
        code: "portable.local-path-field",
        path: nestedPath,
        message: `${key} is local to a device and cannot be packaged`,
        severity: "error",
      })
    }
    pushForbiddenPayloadIssues(nested, nestedPath, issues)
  }
}

/** What a `{{ }}` token in a payload turns out to be. */
export type TemplateTokenKind = "input" | "workflowExpression" | "unknown"

/**
 * Classify one token's contents.
 *
 * The single definition of "is this an input reference?", shared by the
 * validator below and by the Studio's authoring surface. Two copies of this
 * decision would let the editor offer to declare an input for a workflow
 * expression, or stay quiet about a token that then fails on save.
 */
export function classifyTemplateToken(
  expression: string,
  inputIds: ReadonlySet<string>,
  allowWorkflowExpressions: boolean
): TemplateTokenKind {
  const trimmed = expression.trim()
  if (IDENTIFIER.test(trimmed) && inputIds.has(trimmed)) return "input"
  if (allowWorkflowExpressions && tokenize(trimmed).length > 0) return "workflowExpression"
  return "unknown"
}

/**
 * Every `{{ }}` token in a payload, split by what it turns out to be.
 *
 * The Studio uses `unknown` to offer "declare these": an undeclared token is
 * precisely what `interpolation.unknown` refuses on save, so the editor can say
 * so while it is still fixable rather than after the save bounces. Ids come back
 * de-duplicated, in the order first met, because that is the order someone
 * reading the payload would meet them in.
 */
export function listTemplateTokens(
  payload: TemplateJson,
  inputIds: ReadonlySet<string>,
  allowWorkflowExpressions: boolean
): { input: string[]; unknown: string[] } {
  const input: string[] = []
  const unknown: string[] = []
  const walk = (value: TemplateJson): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const expression = match[1].trim()
        const kind = classifyTemplateToken(expression, inputIds, allowWorkflowExpressions)
        if (kind === "input" && !input.includes(expression)) input.push(expression)
        // A workflow expression is not an authoring gap — it belongs to the
        // workflow engine and is evaluated when the workflow runs.
        if (kind === "unknown" && !unknown.includes(expression)) unknown.push(expression)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value && typeof value === "object") Object.values(value).forEach(walk)
  }
  walk(payload)
  return { input, unknown }
}

function pushInterpolationIssues(
  value: TemplateJson,
  path: string,
  inputIds: ReadonlySet<string>,
  allowWorkflowExpressions: boolean,
  issues: TemplateValidationIssue[]
): void {
  if (typeof value === "string") {
    if (value.includes("${") || value.includes("<%")) {
      issues.push({
        code: "interpolation.unsafe",
        path,
        message: "Only allowlisted {{inputId}} interpolation is supported",
        severity: "error",
      })
    }
    for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const expression = match[1].trim()
      if (classifyTemplateToken(expression, inputIds, allowWorkflowExpressions) === "unknown") {
        issues.push({
          code: "interpolation.unknown",
          path,
          message: `Interpolation must reference a declared input: ${expression}`,
          severity: "error",
        })
      }
    }
    const withoutAllowedTokens = value.replace(/\{\{[^{}]+\}\}/g, "")
    if (withoutAllowedTokens.includes("{{") || withoutAllowedTokens.includes("}}")) {
      issues.push({
        code: "interpolation.malformed",
        path,
        message: "Interpolation markers must be balanced and contain one declared input id",
        severity: "error",
      })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((nested, index) =>
      pushInterpolationIssues(
        nested,
        `${path}[${index}]`,
        inputIds,
        allowWorkflowExpressions,
        issues
      )
    )
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    pushInterpolationIssues(nested, `${path}.${key}`, inputIds, allowWorkflowExpressions, issues)
  }
}

export function validateTemplateDefinition(
  definition: TemplateDefinitionEnvelope
): TemplateValidationResult {
  const issues: TemplateValidationIssue[] = []
  const error = (code: string, path: string, message: string) =>
    issues.push({ code, path, message, severity: "error" })

  if (definition.apiVersion !== TEMPLATE_API_VERSION) {
    error(
      "api-version.unsupported",
      "apiVersion",
      `Unsupported API version ${definition.apiVersion}`
    )
  }
  if (!IDENTIFIER.test(definition.id)) {
    error("id.invalid", "id", "Template id must be a portable dotted identifier")
  }
  if (definition.id !== definition.id.normalize("NFC")) {
    error("id.unicode", "id", "Template id must use canonical Unicode normalization")
  }
  if (!definition.metadata.name.trim()) {
    error("metadata.name", "metadata.name", "Template name is required")
  }
  if (!Number.isInteger(definition.revision) || definition.revision < 1) {
    error("revision.invalid", "revision", "Revision must be a positive integer")
  }
  if (
    ["published", "deprecated", "yanked"].includes(definition.status) &&
    (!definition.version || !SEMVER.test(definition.version))
  ) {
    error("version.required", "version", "Published template releases require semantic versioning")
  }
  if (definition.version && !SEMVER.test(definition.version)) {
    error("version.invalid", "version", "Template version must be valid SemVer")
  }
  if (new Set(definition.inputs.map((input) => input.id)).size !== definition.inputs.length) {
    error("input.duplicate", "inputs", "Template input ids must be unique")
  }
  for (const [index, input] of definition.inputs.entries()) {
    if (!isTemplateInputId(input.id)) {
      error("input.id", `inputs[${index}].id`, "Input id is invalid")
    }
    if (input.kind === "enum" && input.options.length === 0) {
      error("input.enum-options", `inputs[${index}].options`, "Enum inputs require options")
    }
  }
  for (const [index, dependency] of definition.dependencies.entries()) {
    if (
      dependency.kind === "template" &&
      (!dependency.version || !SEMVER.test(dependency.version))
    ) {
      error(
        "dependency.template-version",
        `dependencies[${index}].version`,
        `Template dependency ${dependency.id} must pin an exact semantic version`
      )
    }
    if (dependency.requirement === "optional" && !dependency.fallback) {
      error(
        "dependency.optional-fallback",
        `dependencies[${index}].fallback`,
        `Optional dependency ${dependency.id} must declare omit or default behavior`
      )
    }
    if (dependency.fallback === "default" && dependency.defaultValue === undefined) {
      error(
        "dependency.default-value",
        `dependencies[${index}].defaultValue`,
        `Dependency ${dependency.id} declares a default fallback without a value`
      )
    }
  }
  if (definition.compatibility.platforms.length === 0) {
    error("compatibility.platforms", "compatibility.platforms", "At least one platform is required")
  }
  if (
    definition.compatibility.minHostVersion &&
    !SEMVER.test(definition.compatibility.minHostVersion)
  ) {
    error(
      "compatibility.min-host-version",
      "compatibility.minHostVersion",
      "Minimum host version must be valid SemVer"
    )
  }
  if (
    definition.compatibility.maxHostVersion &&
    !SEMVER.test(definition.compatibility.maxHostVersion)
  ) {
    error(
      "compatibility.max-host-version",
      "compatibility.maxHostVersion",
      "Maximum host version must be valid SemVer"
    )
  }
  pushForbiddenPayloadIssues(definition.payload, "payload", issues)
  pushInterpolationIssues(
    definition.payload,
    "payload",
    new Set(definition.inputs.map((input) => input.id)),
    definition.domain === "workflow",
    issues
  )

  return { ok: issues.every((issue) => issue.severity !== "error"), issues }
}

export type TemplateVersionBump = "patch" | "minor" | "major"

export interface TemplateVersionSuggestion {
  bump: TemplateVersionBump
  reasons: string[]
}

export function suggestTemplateVersionBump(
  previous: TemplateDefinitionEnvelope,
  next: TemplateDefinitionEnvelope
): TemplateVersionSuggestion {
  const reasons: string[] = []
  const previousInputs = new Map(previous.inputs.map((input) => [input.id, input]))
  const nextInputs = new Map(next.inputs.map((input) => [input.id, input]))
  for (const [id, input] of previousInputs) {
    const candidate = nextInputs.get(id)
    if (!candidate) reasons.push(`Input "${id}" was removed`)
    else if (candidate.kind !== input.kind) reasons.push(`Input "${id}" changed type`)
    else if (!input.required && candidate.required) reasons.push(`Input "${id}" became required`)
  }
  for (const dependency of next.dependencies) {
    const previousDependency = previous.dependencies.find(
      (candidate) => candidate.id === dependency.id && candidate.kind === dependency.kind
    )
    if (!previousDependency && dependency.requirement === "required") {
      reasons.push(`Required dependency "${dependency.id}" was added`)
    }
  }
  if (reasons.length > 0) return { bump: "major", reasons }

  const additions = next.inputs.filter((input) => !previousInputs.has(input.id))
  if (additions.length > 0 || next.dependencies.length > previous.dependencies.length) {
    return {
      bump: "minor",
      reasons: [
        ...additions.map((input) => `Optional input "${input.id}" was added`),
        ...(next.dependencies.length > previous.dependencies.length
          ? ["Dependencies were added without introducing a required dependency"]
          : []),
      ],
    }
  }
  return { bump: "patch", reasons: ["No public input or required dependency break was detected"] }
}

export function incrementTemplateVersion(version: string, bump: TemplateVersionBump): string {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`Cannot increment invalid semantic version "${version}"`)
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])
  if (bump === "major") {
    major += 1
    minor = 0
    patch = 0
  } else if (bump === "minor") {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}
