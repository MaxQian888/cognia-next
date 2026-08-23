import { contentDigest } from "./digest"
import type { JsonSchema, SideEffectClass } from "./types"

export const AGENT_DEFINITION_SCHEMA_VERSION = 1 as const

/**
 * The composition a definition selects, declared standalone.
 *
 * Structurally identical to `AgentCompositionSelectionV1` in
 * `@cognia/agent-config-types`, which is a private workspace package and can
 * never be a dependency of a published client — the same reason
 * `handoff-envelope.ts` owns its contract here and the internal package
 * re-exports it. `agent-definition-parity.test.ts` on the host side, which can
 * see both, fails if the two ever drift.
 */
export interface AgentCompositionSelection {
  presetId: string
  authority?: string
  toolPresentation?: string
  orchestration?: string
  engagement?: string
  autonomy?: string
  /** Team id for `team` orchestration, workflow id for `workflow`. */
  orchestrationRef?: string
  /** Reference to an existing `AgentExecutionPolicy` binding, never a runtime. */
  runtimeBindingRef?: string
  /** The `agentModeId` this selection was migrated from, kept for round-trips. */
  legacyModeId?: string
}

/** A JSON Schema the host validates a turn's structured output against. */
export interface JsonSchemaContract {
  schema: JsonSchema
  /** Digest of `schema`, so a mismatch is detectable without re-deriving it. */
  schemaDigest: string
}

/**
 * A tool contract a definition depends on.
 *
 * The contract lives in the definition; the handler never does. The client
 * registers handlers on every connect, and the host refuses to call the model
 * when a referenced tool has no handler or the handler's schema digest differs
 * from the one recorded here.
 */
export interface AgentToolReference {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  sideEffect: SideEffectClass
  /** Digest over `{name, description, inputSchema, outputSchema, sideEffect}`. */
  schemaDigest: string
}

export interface AgentDefinitionV1 {
  schemaVersion: typeof AGENT_DEFINITION_SCHEMA_VERSION
  agentId: string
  version: number
  name: string
  description?: string
  composition: AgentCompositionSelection
  /**
   * Appended to the resolved preset's instructions. There is deliberately no
   * "replace": the host's governance rides on the preset's system policy, and a
   * definition that could overwrite it would be a way around that policy rather
   * than a way to configure an agent.
   */
  instructions?: { append: string }
  runtimeBindingRef?: string
  toolRefs: AgentToolReference[]
  output?: JsonSchemaContract
  metadata?: Record<string, string | number | boolean>
  definitionDigest: string
  createdAt: string
  /** Set when this version has been logically archived. Never deleted. */
  archivedAt?: string
}

/** What a caller supplies. Identity, version and digest are the host's to mint. */
export interface AgentDefinitionInput {
  name: string
  description?: string
  composition: AgentCompositionSelection
  instructions?: { append: string }
  runtimeBindingRef?: string
  toolRefs?: AgentToolReference[]
  output?: JsonSchemaContract
  metadata?: Record<string, string | number | boolean>
  /** Chosen by the caller on create only; minted when absent. */
  agentId?: string
}

export type AgentDefinitionChanges = Omit<AgentDefinitionInput, "agentId">

/** What `agent/list` returns: identity and the head version, not the body. */
export interface AgentDefinitionSummaryV1 {
  agentId: string
  name: string
  latestVersion: number
  definitionDigest: string
  createdAt: string
  archivedAt?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i

/**
 * Metadata keys that would mean a secret is being stored in a definition.
 *
 * A definition is persisted in the clear in the host's data home and copied
 * into session manifests and exports. Credentials belong behind a
 * `runtimeBindingRef`, so anything that looks like one is refused at the door
 * rather than redacted later.
 */
const SECRET_KEY_PATTERN = /(^|[._-])(api[._-]?key|secret|token|password|passwd|credential|bearer)/i

/** The exact object `definitionDigest` covers. */
export function definitionDigestPayload(
  definition: Pick<
    AgentDefinitionV1,
    | "name"
    | "description"
    | "composition"
    | "instructions"
    | "runtimeBindingRef"
    | "toolRefs"
    | "output"
    | "metadata"
  >
): Record<string, unknown> {
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    name: definition.name,
    description: definition.description,
    composition: definition.composition,
    instructions: definition.instructions,
    runtimeBindingRef: definition.runtimeBindingRef,
    toolRefs: definition.toolRefs,
    output: definition.output,
    metadata: definition.metadata,
  }
}

/**
 * Content digest of a definition.
 *
 * Deliberately excludes `agentId`, `version`, `createdAt` and `archivedAt`, so
 * two versions with identical content share a digest — which is how a caller
 * tells "v3 changed the composition" from "v3 exists because someone re-saved
 * the same thing".
 */
export function computeDefinitionDigest(
  definition: Parameters<typeof definitionDigestPayload>[0]
): string {
  return contentDigest(definitionDigestPayload(definition))
}

/** Digest over a tool's wire contract, excluding the digest field itself. */
export function computeToolSchemaDigest(tool: Omit<AgentToolReference, "schemaDigest">): string {
  return contentDigest({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    sideEffect: tool.sideEffect,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Every reason this input cannot become a definition. Empty means valid. */
export function validateAgentDefinitionInput(value: unknown): string[] {
  if (!isRecord(value)) return ["definition must be an object"]
  const errors: string[] = []

  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    errors.push("name must be a non-empty string")
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    errors.push("description must be a string when present")
  }
  if (value.agentId !== undefined && !ID_PATTERN.test(String(value.agentId))) {
    errors.push("agentId must match [a-z0-9][a-z0-9._-]{0,127}")
  }
  if (!isRecord(value.composition) || typeof value.composition.presetId !== "string") {
    errors.push("composition must carry a presetId")
  }
  if (value.instructions !== undefined) {
    if (!isRecord(value.instructions)) {
      errors.push("instructions must be an object")
    } else {
      if (typeof value.instructions.append !== "string") {
        errors.push("instructions.append must be a string")
      }
      for (const key of Object.keys(value.instructions)) {
        if (key !== "append") {
          errors.push(
            `instructions.${key} is not supported; a definition may only append to the ` +
              "preset's instructions, never replace the system policy"
          )
        }
      }
    }
  }
  if (value.runtimeBindingRef !== undefined && typeof value.runtimeBindingRef !== "string") {
    errors.push("runtimeBindingRef must be a string reference")
  }
  if (value.toolRefs !== undefined) {
    if (!Array.isArray(value.toolRefs)) {
      errors.push("toolRefs must be an array")
    } else {
      const names = new Set<string>()
      value.toolRefs.forEach((tool, index) => {
        if (!isRecord(tool)) {
          errors.push(`toolRefs[${index}] must be an object`)
          return
        }
        if (typeof tool.name !== "string" || tool.name.length === 0) {
          errors.push(`toolRefs[${index}].name must be a non-empty string`)
        } else if (names.has(tool.name)) {
          errors.push(`toolRefs[${index}] duplicates the tool name ${tool.name}`)
        } else {
          names.add(tool.name)
        }
        if (typeof tool.description !== "string") {
          errors.push(`toolRefs[${index}].description must be a string`)
        }
        if (!isRecord(tool.inputSchema)) {
          errors.push(`toolRefs[${index}].inputSchema must be a JSON Schema object`)
        }
        if (tool.outputSchema !== undefined && !isRecord(tool.outputSchema)) {
          errors.push(`toolRefs[${index}].outputSchema must be a JSON Schema object`)
        }
        if (!["none", "idempotent", "non-idempotent"].includes(String(tool.sideEffect))) {
          errors.push(`toolRefs[${index}].sideEffect must be none|idempotent|non-idempotent`)
        }
        if (typeof tool.schemaDigest !== "string" || tool.schemaDigest.length === 0) {
          errors.push(`toolRefs[${index}].schemaDigest must be present`)
        } else if (
          isRecord(tool.inputSchema) &&
          computeToolSchemaDigest(tool as unknown as Omit<AgentToolReference, "schemaDigest">) !==
            tool.schemaDigest
        ) {
          errors.push(`toolRefs[${index}].schemaDigest does not match its contract`)
        }
      })
    }
  }
  if (value.output !== undefined) {
    if (!isRecord(value.output) || !isRecord(value.output.schema)) {
      errors.push("output.schema must be a JSON Schema object")
    } else if (contentDigest(value.output.schema) !== value.output.schemaDigest) {
      errors.push("output.schemaDigest does not match output.schema")
    }
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      errors.push("metadata must be an object")
    } else {
      for (const [key, member] of Object.entries(value.metadata)) {
        if (!["string", "number", "boolean"].includes(typeof member)) {
          errors.push(`metadata.${key} must be a string, number or boolean`)
        }
        if (SECRET_KEY_PATTERN.test(key)) {
          errors.push(
            `metadata.${key} looks like a credential; definitions are stored in the clear and ` +
              "copied into session manifests. Reference host credentials with runtimeBindingRef."
          )
        }
      }
    }
  }
  return errors
}

/** Mint a definition at `version`, computing its digest. Input must be valid. */
export function buildAgentDefinition(
  input: AgentDefinitionInput,
  identity: { agentId: string; version: number; createdAt: string }
): AgentDefinitionV1 {
  const body = {
    name: input.name.trim(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    composition: input.composition,
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.runtimeBindingRef !== undefined
      ? { runtimeBindingRef: input.runtimeBindingRef }
      : {}),
    toolRefs: input.toolRefs ? [...input.toolRefs] : [],
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
  return {
    schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
    agentId: identity.agentId,
    version: identity.version,
    ...body,
    definitionDigest: computeDefinitionDigest(body),
    createdAt: identity.createdAt,
  }
}

export function isAgentDefinitionV1(value: unknown): value is AgentDefinitionV1 {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION) return false
  if (typeof value.agentId !== "string" || !ID_PATTERN.test(value.agentId)) return false
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) {
    return false
  }
  if (typeof value.definitionDigest !== "string") return false
  if (typeof value.createdAt !== "string") return false
  if (!Array.isArray(value.toolRefs)) return false
  if (validateAgentDefinitionInput({ ...value, agentId: value.agentId }).length > 0) return false
  return computeDefinitionDigest(value as unknown as AgentDefinitionV1) === value.definitionDigest
}
