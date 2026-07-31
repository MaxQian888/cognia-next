import { generateText } from "ai"
import type { UserProviderSettings } from "@cognia/provider-types"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"
import type { ApiTestResult } from "@cognia/provider-core/providers/api-test"

import { createFeatureProviderModel, type ResolvedProvider } from "@/lib/ai/provider-consumption"
import {
  discoverBedrockModelsViaSidecar,
  type BedrockDiscoveredModel,
} from "@/lib/claude/feature-call"

interface BedrockConnectionDependencies {
  generateText: typeof generateText
  discover: typeof discoverBedrockModelsViaSidecar
}

const DEFAULT_DEPS: BedrockConnectionDependencies = {
  generateText,
  discover: discoverBedrockModelsViaSidecar,
}

export interface BedrockConnectionResult {
  test: ApiTestResult
  models?: BedrockDiscoveredModel[]
  discoveryError?: string
}

function credentialMetadata(settings: NonNullable<UserProviderSettings["bedrock"]>) {
  return {
    protocol: "bedrock",
    bedrockAuthMode: settings.authMode,
    region: settings.region,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    sessionToken: settings.sessionToken,
    profile: settings.profile,
    roleArn: settings.roleArn,
    roleSessionName: settings.roleSessionName,
  } as const
}

function scrubError(error: unknown, settings: NonNullable<UserProviderSettings["bedrock"]>) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [
    settings.apiKey,
    settings.accessKeyId,
    settings.secretAccessKey,
    settings.sessionToken,
  ]) {
    if (secret) message = message.split(secret).join("[REDACTED]")
  }
  return message
}

export async function testAndDiscoverBedrock(
  settings: UserProviderSettings,
  deps: BedrockConnectionDependencies = DEFAULT_DEPS
): Promise<BedrockConnectionResult> {
  const bedrock = settings.bedrock
  if (!bedrock) {
    return {
      test: { success: false, outcome: "failed", message: "Bedrock settings are missing." },
    }
  }
  const validation = validateBedrockConnectionSettings(bedrock)
  if (!validation.valid) {
    return {
      test: {
        success: false,
        outcome: "failed",
        message: `Bedrock configuration requires: ${validation.issues
          .map((issue) => issue.field)
          .join(", ")}.`,
      },
    }
  }

  const startedAt = performance.now()
  const resolved: ResolvedProvider = {
    kind: "resolved",
    providerId: "bedrock",
    protocol: "bedrock",
    apiKey: bedrock.authMode === "api-key" ? bedrock.apiKey : undefined,
    baseURL: bedrock.baseURL,
    bedrock,
    model: settings.defaultModel,
    isCustomProvider: false,
    useProxy: bedrock.authMode === "default-chain",
  }
  try {
    await deps.generateText({
      model: createFeatureProviderModel(resolved),
      prompt: "Reply with OK.",
      maxOutputTokens: 4,
      temperature: 0,
    })
    const test: ApiTestResult = {
      success: true,
      outcome: "verified",
      latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      message: "Amazon Bedrock connection verified.",
    }
    if (bedrock.authMode === "api-key") return { test }
    try {
      const models = await deps.discover(credentialMetadata(bedrock))
      return { test, models }
    } catch (error) {
      return { test, discoveryError: scrubError(error, bedrock) }
    }
  } catch (error) {
    return {
      test: {
        success: false,
        outcome: "failed",
        latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        message: scrubError(error, bedrock),
      },
    }
  }
}
