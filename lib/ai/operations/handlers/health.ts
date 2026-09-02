/**
 * `auth.status` and `health.probe`.
 *
 * `auth.status` is derived from the resolved provider alone: no call. The
 * probe reuses `runProviderProbe`, the same free capability probe the
 * diagnostics screen runs, so "healthy" means one thing across surfaces.
 */

import type { ProviderProbeResult } from "@cognia/provider-types"

import { runProviderProbe } from "@/lib/provider-diagnostics/probe"

import { credentialAffinityOf } from "../credential-affinity"
import type { ProviderOperationHandlerRegistration } from "../registry"

export interface AuthStatusOutput {
  configured: boolean
  credentialFingerprint?: string
  method: "api-key" | "oauth" | "subscription" | "none" | "other"
  expiresAt?: number
}

export const authStatusHandler: ProviderOperationHandlerRegistration<
  { deploymentRef?: string },
  AuthStatusOutput
> = {
  operationId: "auth.status",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider }) {
    if (provider.bedrock && provider.bedrock.authMode !== "api-key") {
      return {
        configured: true,
        method: "other",
        credentialFingerprint: credentialAffinityOf(
          provider.bedrock.accessKeyId ??
            provider.bedrock.profile ??
            provider.bedrock.roleArn ??
            "default-chain"
        ),
      }
    }
    if (provider.apiKey) {
      return {
        configured: true,
        method: "api-key",
        credentialFingerprint: credentialAffinityOf(provider.apiKey),
      }
    }
    // A keyless provider with a base URL (local models) is configured.
    return { configured: Boolean(provider.baseURL), method: "none" }
  },
}

export interface HealthProbeInput {
  model?: string
  timeoutMs?: number
}

export const healthProbeHandler: ProviderOperationHandlerRegistration<
  HealthProbeInput,
  ProviderProbeResult
> = {
  operationId: "health.probe",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    return runProviderProbe(
      {
        providerId: provider.providerId,
        protocol: provider.protocol,
        baseURL: provider.baseURL ?? "",
        apiKey: provider.apiKey,
        headers: provider.headers,
        model: request.input?.model ?? provider.model,
        bedrock: provider.bedrock
          ? {
              authMode: provider.bedrock.authMode,
              region: provider.bedrock.region,
              accessKeyId: provider.bedrock.accessKeyId,
              secretAccessKey: provider.bedrock.secretAccessKey,
              sessionToken: provider.bedrock.sessionToken,
              profile: provider.bedrock.profile,
              roleArn: provider.bedrock.roleArn,
              roleSessionName: provider.bedrock.roleSessionName,
            }
          : undefined,
      },
      { timeoutMs: request.input?.timeoutMs, signal }
    )
  },
}

export const HEALTH_HANDLERS = [authStatusHandler, healthProbeHandler]
