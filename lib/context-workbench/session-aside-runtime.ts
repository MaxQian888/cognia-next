import type { ChatSession } from "@cognia/agent-config-types"
import type { AcpCapabilities, ExternalAgentProtocol } from "@/types/agent/external-agent"
import type { ExternalAgentCapabilityProfileV1 } from "@cognia/agent-config-types/external-agent-capability"
import { BUILTIN_RUNTIME_REF, type AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import {
  deriveExternalSessionPermission,
  type ExternalSessionPermissionSpec,
} from "@/lib/ai/agent/external/policy/permission-cascade"
import {
  attestsExternalPermissionMode,
  hasUnsupportedExternalPermissionDimensions,
} from "@/lib/ai/agent/external/policy/permission-ceiling"
import { buildDeclaredCapabilityProfile } from "@/lib/ai/agent/external/capability/capability-profile"

export interface AsideExternalRuntime {
  protocol: ExternalAgentProtocol
  capabilities?: AcpCapabilities
  capabilityProfile?: ExternalAgentCapabilityProfileV1
}

export interface SessionAsideRuntimeInput {
  session: ChatSession
  parentRuntimeRef: AgentRuntimeRef
  external?: AsideExternalRuntime
  parentPermission?: ExternalSessionPermissionSpec
  /** Router/Fusion and other non-direct compositions use Cognia's resolver. */
  forceBuiltin?: boolean
}

/** One routing decision shared by the send resolver and the side-chat indicator. */
export function resolveSessionAsideRuntime(input: SessionAsideRuntimeInput): {
  runtimeRef: AgentRuntimeRef
  readOnly: boolean
  usesBuiltinFallback: boolean
  fallbackReason?: "read-only-unattested" | "permission-unattested" | "non-direct"
  permissionCeiling: ExternalSessionPermissionSpec
} {
  const requestedReadOnly = input.session.asideWriteAccess !== true
  const permissionCeiling = deriveExternalSessionPermission(
    deriveExternalSessionPermission(input.parentPermission ?? {}, {
      // The classifier-backed built-in mode has no external equivalent.
      permissionMode:
        input.session.permissionMode === "auto" ? "default" : input.session.permissionMode,
    }),
    requestedReadOnly ? { permissionMode: "plan" } : undefined
  )
  const readOnly = permissionCeiling.permissionMode === "plan"
  const needsPlan = permissionCeiling.permissionMode === "plan"
  const externalPlanAttested =
    input.parentRuntimeRef.kind === "external" &&
    input.external !== undefined &&
    attestsExternalPermissionMode(
      input.external.protocol,
      input.external.capabilities,
      "plan",
      input.external.capabilityProfile
    )
  const fallbackReason = input.forceBuiltin
    ? "non-direct"
    : input.parentRuntimeRef.kind !== "builtin" &&
        hasUnsupportedExternalPermissionDimensions(permissionCeiling)
      ? "permission-unattested"
      : input.parentRuntimeRef.kind !== "builtin" && needsPlan && !externalPlanAttested
        ? "read-only-unattested"
        : undefined
  const usesBuiltinFallback = input.parentRuntimeRef.kind !== "builtin" && Boolean(fallbackReason)
  return {
    runtimeRef: fallbackReason ? BUILTIN_RUNTIME_REF : input.parentRuntimeRef,
    readOnly,
    usesBuiltinFallback,
    ...(fallbackReason ? { fallbackReason } : {}),
    permissionCeiling,
  }
}

/** Load negotiated facts without pulling the process manager into the panel's eager bundle. */
export async function resolveSessionAsideRuntimeWithAgent(
  input: Omit<SessionAsideRuntimeInput, "external">,
  loadExternal: (agentId: string) => Promise<AsideExternalRuntime | undefined> = async (
    agentId
  ) => {
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const agent = getExternalAgentManager().getAgent(agentId)
    return agent
      ? {
          protocol: agent.config.protocol,
          capabilities: agent.capabilities,
          capabilityProfile:
            getExternalAgentManager().getAgentCapabilityProfile(agentId) ??
            buildDeclaredCapabilityProfile({
              protocol: agent.config.protocol,
              presetId:
                typeof agent.config.metadata?.preset === "string"
                  ? agent.config.metadata.preset
                  : undefined,
              userDeclared: agent.config.declaredCapabilities,
            }),
        }
      : undefined
  }
) {
  const external =
    input.parentRuntimeRef.kind === "external"
      ? await loadExternal(input.parentRuntimeRef.agentId)
      : undefined
  return resolveSessionAsideRuntime({ ...input, external })
}
