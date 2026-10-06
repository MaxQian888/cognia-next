/**
 * Stable, secret-free handoff contract shared by dispatching brains and workers.
 * Ref fields deliberately exclude endpoints, credentials, and host-local paths.
 */
import * as v from "valibot"

const portablePath = v.pipe(
  v.string(),
  v.check(
    (value) =>
      value === "." ||
      (!!value &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        value.split("/").every((part) => !!part && part !== ".." && part !== ".")),
    "path must be relative to the bound workspace"
  )
)
const strings = v.array(v.pipe(v.string(), v.minLength(1)))
export const handoffPolicyV1Schema = v.strictObject({
  policyVersion: v.literal(1),
  permissionMode: v.optional(
    v.picklist(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
  ),
  allowedTools: v.optional(strings),
  disallowedTools: v.optional(strings),
  mcpServerNames: v.optional(strings),
  sandboxRequired: v.boolean(),
  sandboxPolicy: v.optional(
    v.strictObject({
      maxCpuSeconds: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
      maxMemoryMb: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
      network: v.optional(v.picklist(["off", "on", "allowlist"])),
      networkAllowlist: v.optional(strings),
      writableRoots: v.optional(v.array(portablePath)),
      readableRoots: v.optional(v.array(portablePath)),
    })
  ),
})
export type HandoffPolicyV1 = v.InferOutput<typeof handoffPolicyV1Schema>
export function isHandoffPolicyV1(value: unknown): value is HandoffPolicyV1 {
  const parsed = v.safeParse(handoffPolicyV1Schema, value)
  return parsed.success && (!parsed.output.sandboxPolicy || parsed.output.sandboxRequired)
}

export type HandoffRuntimeAdapterId = "claude-agent-sdk" | "ai-sdk" | "external"

export interface HandoffExecutionBinding {
  policy?: HandoffPolicyV1
  mode: "native" | "orchestrated"
  executionFingerprint?: string
  runtimeAdapter?: HandoffRuntimeAdapterId
  deploymentRef?: string
  credentialProfileRef?: string
  hostRef?: string
  modelRole?: "primary" | "fast" | "powerful"
  modelBindingRef?: string
  requiredCapabilities?: string[]
  requiredSandboxCapabilities?: string[]
}

export interface HandoffResourceRef {
  kind: string
  ref: string
}

export interface HandoffEnvelope {
  envelopeVersion: 1
  identity: {
    parentRunId: string
    childRunId: string
    teamId?: string
    taskId?: string
    depth: number
    parentChain: string[]
  }
  task: {
    title?: string
    prompt: string
    expectedOutput?: string
  }
  execution: HandoffExecutionBinding
  budget?: { maxTokens?: number }
  resources?: HandoffResourceRef[]
  createdAt: string
}

const SECRET_SHAPE = /sk-[A-Za-z0-9]|api[_-]?key|bearer\s|(^|[^a-z])token[=:]/i
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i
const ABSOLUTE_PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/])/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function refViolation(value: string): string | null {
  if (SECRET_SHAPE.test(value)) return "secret-shaped value in a ref position"
  if (URL_SHAPE.test(value)) return "URL-shaped value in a ref position"
  return null
}

function absolutePathViolation(value: string): string | null {
  return ABSOLUTE_PATH_SHAPE.test(value) ? "machine-local absolute path is not a stable ref" : null
}

export function validateHandoffEnvelope(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== "object") return ["envelope must be an object"]
  const envelope = value as Partial<HandoffEnvelope>

  if (envelope.envelopeVersion !== 1) errors.push("envelopeVersion must be 1")

  const identity = envelope.identity
  if (!identity || typeof identity !== "object") {
    errors.push("identity is required")
  } else {
    if (!isNonEmptyString(identity.parentRunId)) errors.push("identity.parentRunId is required")
    if (!isNonEmptyString(identity.childRunId)) errors.push("identity.childRunId is required")
    if (
      typeof identity.depth !== "number" ||
      identity.depth < 1 ||
      !Number.isInteger(identity.depth)
    ) {
      errors.push("identity.depth must be an integer >= 1")
    }
    if (
      !Array.isArray(identity.parentChain) ||
      identity.parentChain.some((item) => !isNonEmptyString(item))
    ) {
      errors.push("identity.parentChain must be a string array")
    }
  }

  if (!envelope.task || !isNonEmptyString(envelope.task.prompt)) {
    errors.push("task.prompt is required")
  }

  const execution = envelope.execution
  if (!execution || typeof execution !== "object") {
    errors.push("execution is required")
  } else {
    if (execution.policy !== undefined && !isHandoffPolicyV1(execution.policy))
      errors.push("execution.policy is not a supported portable policy")
    if (execution.mode !== "native" && execution.mode !== "orchestrated") {
      errors.push('execution.mode must be "native" or "orchestrated"')
    }
    for (const [field, ref] of [
      ["deploymentRef", execution.deploymentRef],
      ["credentialProfileRef", execution.credentialProfileRef],
      ["hostRef", execution.hostRef],
      ["modelBindingRef", execution.modelBindingRef],
    ] as const) {
      if (ref === undefined) continue
      if (!isNonEmptyString(ref)) {
        errors.push(`execution.${field} must be a non-empty string`)
        continue
      }
      const violation = refViolation(ref)
      if (violation) errors.push(`execution.${field}: ${violation}`)
    }
    if (
      execution.requiredCapabilities !== undefined &&
      (!Array.isArray(execution.requiredCapabilities) ||
        execution.requiredCapabilities.some((item) => !isNonEmptyString(item)))
    ) {
      errors.push("execution.requiredCapabilities must be a non-empty string array")
    }
    if (
      execution.requiredSandboxCapabilities !== undefined &&
      (!Array.isArray(execution.requiredSandboxCapabilities) ||
        execution.requiredSandboxCapabilities.some((item) => !isNonEmptyString(item)))
    ) {
      errors.push("execution.requiredSandboxCapabilities must be a non-empty string array")
    }
  }

  for (const [index, resource] of (envelope.resources ?? []).entries()) {
    if (!resource || !isNonEmptyString(resource.kind) || !isNonEmptyString(resource.ref)) {
      errors.push(`resources[${index}] must have kind and ref`)
      continue
    }
    const violation = refViolation(resource.ref)
    if (violation) errors.push(`resources[${index}].ref: ${violation}`)
    const pathViolation = absolutePathViolation(resource.ref)
    if (pathViolation) errors.push(`resources[${index}].ref: ${pathViolation}`)
  }

  if (!isNonEmptyString(envelope.createdAt) || Number.isNaN(Date.parse(envelope.createdAt))) {
    errors.push("createdAt must be an ISO timestamp")
  }

  return errors
}

export function isHandoffEnvelope(value: unknown): value is HandoffEnvelope {
  return validateHandoffEnvelope(value).length === 0
}
