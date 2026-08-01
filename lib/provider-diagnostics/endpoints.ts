import type {
  ProviderEndpointCandidate,
  ProviderEndpointCandidateSource,
  ProviderEndpointChange,
} from "@cognia/provider-types"
import type { CcswitchProvider } from "@/types/ccswitch"

import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { FeatureCallCredentials } from "@cognia/agent-config-types"
import type { ProviderProbeResult } from "@cognia/provider-types"

import { runProviderProbe } from "./probe"

export class ProviderEndpointConflictError extends Error {
  constructor(message = "The provider endpoint changed after this diagnostic action.") {
    super(message)
    this.name = "ProviderEndpointConflictError"
  }
}

interface EndpointSourceInput {
  providerId: string
  current?: string
  catalog?: string[]
  user?: string[]
  ccswitch?: string[]
}

function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "")
  } catch {
    return null
  }
}

function candidateId(providerId: string, endpoint: string): string {
  return `${providerId}:${encodeURIComponent(endpoint)}`
}

/** Build the allowlisted endpoint set. No network/community discovery occurs here. */
export function collectProviderEndpointCandidates(
  input: EndpointSourceInput
): ProviderEndpointCandidate[] {
  const ordered: Array<[ProviderEndpointCandidateSource, string | undefined]> = [
    ["current", input.current],
    ...(input.catalog ?? []).map((url): [ProviderEndpointCandidateSource, string] => [
      "catalog",
      url,
    ]),
    ...(input.user ?? []).map((url): [ProviderEndpointCandidateSource, string] => ["user", url]),
    ...(input.ccswitch ?? []).map((url): [ProviderEndpointCandidateSource, string] => [
      "ccswitch",
      url,
    ]),
  ]
  const seen = new Set<string>()
  const candidates: ProviderEndpointCandidate[] = []
  for (const [source, raw] of ordered) {
    if (!raw) continue
    const url = normalizeEndpoint(raw)
    if (!url || seen.has(url)) continue
    seen.add(url)
    candidates.push({
      id: candidateId(input.providerId, url),
      providerId: input.providerId,
      url,
      source,
    })
  }
  return candidates
}

export function extractCcswitchProviderEndpoints(
  providerId: string,
  providers: CcswitchProvider[]
): string[] {
  const aliases: Record<string, string[]> = {
    anthropic: ["anthropic", "claude"],
    openai: ["openai", "codex"],
    google: ["google", "gemini"],
  }
  const matchers = aliases[providerId] ?? [providerId]
  return providers.flatMap((provider) => {
    const identity = `${provider.id} ${provider.name} ${provider.kind ?? ""}`.toLowerCase()
    if (!matchers.some((matcher) => identity.includes(matcher.toLowerCase()))) return []
    const endpoint = provider.baseUrl?.trim()
    if (!endpoint) return []
    try {
      const url = new URL(endpoint)
      if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return []
      url.search = ""
      url.hash = ""
      return [url.toString().replace(/\/$/, "")]
    } catch {
      return []
    }
  })
}

interface EndpointDependencies {
  compareAndSwap: (providerId: string, expected: string, next: string) => Promise<boolean>
  now: () => number
  randomUUID: () => string
}

const DEFAULT_DEPENDENCIES: EndpointDependencies = {
  compareAndSwap: (providerId, expected, next) =>
    useSettingsStore.getState().compareAndSwapProviderEndpoint(providerId, expected, next),
  now: Date.now,
  randomUUID: () => crypto.randomUUID(),
}

export async function applyProviderEndpoint(
  input: {
    providerId: string
    endpoint: string
    expectedCurrentEndpoint: string
  },
  dependencies: Partial<EndpointDependencies> = {}
): Promise<ProviderEndpointChange> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const endpoint = normalizeEndpoint(input.endpoint)
  const previous = normalizeEndpoint(input.expectedCurrentEndpoint)
  if (!endpoint || !previous) throw new Error("A valid HTTP(S) provider endpoint is required.")
  const swapped = await deps.compareAndSwap(input.providerId, previous, endpoint)
  if (!swapped) throw new ProviderEndpointConflictError()
  const change: ProviderEndpointChange = {
    id: deps.randomUUID(),
    providerId: input.providerId,
    previousEndpoint: previous,
    appliedEndpoint: endpoint,
    appliedAt: deps.now(),
  }
  await getDb().providerEndpointChanges.put(change)
  return change
}

export async function rollbackProviderEndpoint(
  changeId: string,
  dependencies: Partial<EndpointDependencies> = {}
): Promise<ProviderEndpointChange> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const change = await getDb().providerEndpointChanges.get(changeId)
  if (!change) throw new Error(`Provider endpoint change ${changeId} was not found.`)
  if (change.rolledBackAt !== undefined) return change
  const swapped = await deps.compareAndSwap(
    change.providerId,
    change.appliedEndpoint,
    change.previousEndpoint
  )
  if (!swapped) throw new ProviderEndpointConflictError()
  const rolledBack = { ...change, rolledBackAt: deps.now() }
  await getDb().providerEndpointChanges.put(rolledBack)
  return rolledBack
}

interface FreeEndpointTarget {
  id: string
  providerId: string
  endpoint: string
  modelId?: string
  credentialFingerprint: string
  capability: "probe"
  credentials: FeatureCallCredentials
}

export interface ProviderEndpointProbeComparison {
  targetId: string
  endpoint: string
  probe: ProviderProbeResult
  recommended: boolean
}

/** Free comparison ranks network reachability/duration; recommendation adds auth/capability gates. */
export async function compareProviderEndpointsFree(
  targets: FreeEndpointTarget[],
  dependencies: {
    probe?: (target: FreeEndpointTarget) => Promise<ProviderProbeResult>
  } = {}
): Promise<ProviderEndpointProbeComparison[]> {
  const probe =
    dependencies.probe ??
    ((target: FreeEndpointTarget) =>
      runProviderProbe({
        providerId: target.providerId,
        protocol: target.credentials.protocol ?? "openai",
        baseURL: target.endpoint,
        apiKey: target.credentials.apiKey,
        headers: target.credentials.headers,
        model: target.modelId,
      }))
  const rows = await Promise.all(
    targets.map(async (target) => ({
      targetId: target.id,
      endpoint: target.endpoint,
      probe: await probe(target),
      recommended: false,
    }))
  )
  rows.sort(
    (left, right) =>
      Number(right.probe.reachable) - Number(left.probe.reachable) ||
      left.probe.durationMs - right.probe.durationMs
  )
  const recommended = rows.find(
    (row) =>
      row.probe.reachable && row.probe.authenticated !== false && row.probe.capabilityVerified
  )
  if (recommended) recommended.recommended = true
  return rows
}
