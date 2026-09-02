import type { ProviderDiagnosticFailure, ProviderProbeResult } from "@cognia/provider-types"

import { proxyFetch } from "@/lib/network/proxy-fetch"

export interface ProviderProbeInput {
  providerId: string
  protocol: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  model?: string
  bedrock?: {
    authMode?: "api-key" | "iam" | "default-chain"
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
    sessionToken?: string
    profile?: string
    roleArn?: string
    roleSessionName?: string
  }
}

interface ProbeDependencies {
  fetchImpl?: typeof fetch
  now?: () => number
  delay?: (ms: number) => Promise<void>
  discoverBedrock?: (input: ProviderProbeInput, signal: AbortSignal) => Promise<unknown[]>
  timeoutMs?: number
  signal?: AbortSignal
}

interface ProbeRequest {
  url: string
  init: RequestInit
  verifiesCapability: boolean
}

function appendPath(baseURL: string, path: string): string {
  return `${baseURL.trim().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function buildProbeRequest(input: ProviderProbeInput): ProbeRequest {
  const protocol = input.protocol.toLowerCase()
  const headers: Record<string, string> = { Accept: "application/json", ...input.headers }
  if (protocol === "google" || protocol === "gemini") {
    if (input.apiKey) headers["x-goog-api-key"] = input.apiKey
    return {
      url: appendPath(input.baseURL, "models"),
      init: { method: "GET", headers },
      verifiesCapability: true,
    }
  }
  if (protocol === "anthropic") {
    if (input.apiKey) headers["x-api-key"] = input.apiKey
    headers["anthropic-version"] = "2023-06-01"
    const base = input.baseURL.endsWith("/v1") ? input.baseURL : appendPath(input.baseURL, "v1")
    return {
      url: appendPath(base, "models"),
      init: { method: "GET", headers },
      verifiesCapability: true,
    }
  }
  if (input.providerId === "ollama") {
    return {
      url: appendPath(input.baseURL, "api/tags"),
      init: { method: "GET", headers },
      verifiesCapability: true,
    }
  }
  if (["openai", "azure", "mistral", "cohere"].includes(protocol)) {
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
    return {
      url: appendPath(input.baseURL, "models"),
      init: { method: "GET", headers },
      verifiesCapability: true,
    }
  }
  return { url: input.baseURL, init: { method: "GET", headers }, verifiesCapability: false }
}

/**
 * The one HTTP-status → diagnostic-failure table. Exported so the provider
 * operation executor (`lib/ai/operations/failure.ts`) reuses it instead of
 * keeping a second copy.
 */
export function failureForStatus(status: number): ProviderDiagnosticFailure {
  if (status === 401 || status === 403) {
    return {
      code: status === 401 ? "authentication" : "permission",
      retryable: false,
      message: `Provider rejected credentials (HTTP ${status})`,
      httpStatus: status,
    }
  }
  if (status === 404) {
    return {
      code: "capability-unsupported",
      retryable: false,
      message: "The provider does not expose the free capability probe endpoint",
      httpStatus: status,
    }
  }
  if (status === 408) {
    return {
      code: "timeout",
      retryable: true,
      message: "Provider probe timed out",
      httpStatus: status,
    }
  }
  if (status === 429) {
    return {
      code: "rate-limited",
      retryable: true,
      message: "Provider rate limited the probe",
      httpStatus: status,
    }
  }
  if (status >= 500) {
    return {
      code: "transport",
      retryable: true,
      message: `Provider error (HTTP ${status})`,
      httpStatus: status,
    }
  }
  return {
    code: "invalid-response",
    retryable: false,
    message: `Provider rejected the free probe (HTTP ${status})`,
    httpStatus: status,
  }
}

export function transportFailure(error: unknown): ProviderDiagnosticFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: /abort|timeout/i.test(message) ? "timeout" : "network",
    retryable: true,
    message,
  }
}

function combinedSignal(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second])
  const controller = new AbortController()
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason)
  first.addEventListener("abort", forward(first), { once: true })
  second.addEventListener("abort", forward(second), { once: true })
  return controller.signal
}

async function defaultDiscoverBedrock(
  input: ProviderProbeInput,
  signal: AbortSignal
): Promise<unknown[]> {
  const { discoverBedrockModelsViaSidecar } = await import("@/lib/claude/feature-call")
  return discoverBedrockModelsViaSidecar(
    {
      protocol: "bedrock",
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      bedrockAuthMode: input.bedrock?.authMode,
      region: input.bedrock?.region,
      accessKeyId: input.bedrock?.accessKeyId,
      secretAccessKey: input.bedrock?.secretAccessKey,
      sessionToken: input.bedrock?.sessionToken,
      profile: input.bedrock?.profile,
      roleArn: input.bedrock?.roleArn,
      roleSessionName: input.bedrock?.roleSessionName,
    },
    signal
  )
}

export async function runProviderProbe(
  input: ProviderProbeInput,
  dependencies: ProbeDependencies = {}
): Promise<ProviderProbeResult> {
  const now = dependencies.now ?? Date.now
  const delay = dependencies.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = dependencies.timeoutMs ?? 15_000
  const startedAt = now()
  let lastFailure: ProviderDiagnosticFailure | undefined

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const signal = combinedSignal(controller.signal, dependencies.signal)
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Probe timed out", "TimeoutError")),
      timeoutMs
    )
    try {
      if (input.protocol.toLowerCase() === "bedrock") {
        const models = await (dependencies.discoverBedrock ?? defaultDiscoverBedrock)(input, signal)
        return {
          reachable: true,
          authenticated: true,
          capabilityVerified: Array.isArray(models),
          durationMs: Math.max(0, now() - startedAt),
        }
      }
      const request = buildProbeRequest(input)
      const response = await (dependencies.fetchImpl ?? proxyFetch)(request.url, {
        ...request.init,
        signal,
      })
      if (response.ok) {
        return {
          reachable: true,
          authenticated: input.apiKey ? true : undefined,
          capabilityVerified: request.verifiesCapability,
          durationMs: Math.max(0, now() - startedAt),
          httpStatus: response.status,
        }
      }
      lastFailure = failureForStatus(response.status)
      if (lastFailure.retryable && attempt < 2) {
        await delay(100 * 2 ** attempt)
        continue
      }
      return {
        reachable: true,
        authenticated: response.status === 401 || response.status === 403 ? false : undefined,
        capabilityVerified: false,
        durationMs: Math.max(0, now() - startedAt),
        httpStatus: response.status,
        failure: lastFailure,
      }
    } catch (error) {
      if (dependencies.signal?.aborted) {
        return {
          reachable: false,
          capabilityVerified: false,
          durationMs: Math.max(0, now() - startedAt),
          failure: {
            code: "aborted",
            retryable: false,
            message: "Provider probe was cancelled",
          },
        }
      }
      lastFailure = transportFailure(error)
      if (attempt < 2) {
        await delay(100 * 2 ** attempt)
        continue
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  return {
    reachable: false,
    capabilityVerified: false,
    durationMs: Math.max(0, now() - startedAt),
    failure: lastFailure ?? { code: "unknown", retryable: false, message: "Probe failed" },
  }
}
