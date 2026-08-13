import * as v from "valibot"

const nonEmptyString = v.pipe(v.string(), v.minLength(1))

export const agentWorkerExecutionProfileV1Schema = v.object({
  profileVersion: v.literal(1),
  backendId: nonEmptyString,
  runtimeAdapter: v.picklist(["claude-agent-sdk", "ai-sdk", "external"]),
  modelBindings: v.object({
    primary: nonEmptyString,
    fast: v.optional(nonEmptyString),
    powerful: v.optional(nonEmptyString),
  }),
  deploymentRefs: v.array(nonEmptyString),
  capabilities: v.array(nonEmptyString),
})

export const agentWorkerManifestV1Schema = v.looseObject({
  manifestVersion: v.literal(1),
  runtime: nonEmptyString,
  models: v.array(nonEmptyString),
  hardCapabilities: v.array(nonEmptyString),
  maxActiveTurns: v.pipe(v.number(), v.integer(), v.minValue(1)),
  credentialProfileRefs: v.array(nonEmptyString),
  workspaceBindingRefs: v.array(nonEmptyString),
  taskWorkspace: v.object({ enabled: v.boolean() }),
  sandbox: v.object({ capabilities: v.array(nonEmptyString) }),
  platform: v.object({ os: nonEmptyString, arch: nonEmptyString }),
  executionProfile: v.optional(agentWorkerExecutionProfileV1Schema),
})

export type AgentWorkerExecutionProfileV1 = v.InferOutput<
  typeof agentWorkerExecutionProfileV1Schema
>
export type AgentWorkerManifestV1 = v.InferOutput<typeof agentWorkerManifestV1Schema>

/** Validate an untrusted worker hello before it can participate in placement. */
export function isAgentWorkerManifestV1(value: unknown): value is AgentWorkerManifestV1 {
  return v.safeParse(agentWorkerManifestV1Schema, value).success
}
