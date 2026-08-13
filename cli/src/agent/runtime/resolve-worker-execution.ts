import type {
  AgentExecutionIdentity,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"
import type { AgentWorkerExecutionProfileV1 } from "@cognia/agent"

import { getAgentExecutionFlags } from "@/lib/ai/agent/execution/feature-flags"
import { resolveAgentExecutionSpec } from "@/lib/ai/agent/execution/resolve-agent-execution-spec"

import { resolveActiveModel } from "../../config/active-model"
import type { ResolvedConfig } from "../../config/schema"
import { selectBackend, type BackendSelectResult } from "./backend-select"

export interface ResolvedWorkerExecution {
  backend: BackendSelectResult
  spec: ResolvedAgentExecutionSpec
  profile: AgentWorkerExecutionProfileV1
}

export function resolveWorkerExecutionProfile(
  config: ResolvedConfig,
  identity?: Partial<AgentExecutionIdentity>
): ResolvedWorkerExecution {
  const selected = selectBackend({ requested: config.agentBackend })
  if (!selected.ok) throw new Error(selected.error.message)

  const model = config.model ?? resolveActiveModel(config) ?? "unknown"
  const deploymentRef = `provider:${config.provider}`
  const provider = config.providers[config.provider]
  const credentialProfileRef =
    provider?.apiKey || provider?.authToken ? `credential:${config.provider}` : undefined
  const { spec, missingRequired } = resolveAgentExecutionSpec({
    surface: "cli",
    environment: {
      isTauri: false,
      isHeadlessHost: true,
      prohibitCompletionFallback: true,
      hostCapabilities: selected.backend.capabilities,
    },
    policy: {
      executionKind: "agent",
      runtimePolicy: selected.backend.kind === "builtin" ? "auto" : undefined,
      routePolicy: "direct",
      deploymentRef,
      ...(credentialProfileRef ? { credentialProfileRef } : {}),
      fallbackPolicy: "none",
    },
    legacy: {
      providerId: config.provider,
      modelId: model,
      ...(selected.backend.kind === "external" ? { runtime: selected.backend.id } : {}),
      toolsEnabled: true,
      requireTools: true,
      channel: selected.backend.kind === "external" ? "external" : "sidecar",
    },
    identity,
    flags: getAgentExecutionFlags(),
  })

  if (missingRequired.length > 0) {
    throw new Error(
      `worker backend is missing required capabilities: ${missingRequired.join(", ")}`
    )
  }

  return {
    backend: selected.backend,
    spec,
    profile: {
      profileVersion: 1,
      backendId: selected.backend.id,
      runtimeAdapter: spec.runtimeAdapter,
      modelBindings: { ...spec.modelBindings },
      deploymentRefs: [deploymentRef],
      capabilities: [...spec.capabilities.effective],
    },
  }
}
