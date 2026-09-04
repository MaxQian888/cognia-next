import type { Skill, SkillCategory, SkillStatus } from "@cognia/agent-config-types"

import {
  BUILT_IN_SKILL_CATALOG,
  builtinSkillId,
  loadBuiltInSkillContent,
  resolveBuiltinSkillIdentity,
  type BuiltInSkillCapabilityId,
  type BuiltInSkillCapabilityRequirement,
  type BuiltInSkillCatalogEntry,
  type BuiltInSkillDelivery,
} from "./built-in-catalog"

export type RuntimeSkillCapability =
  | "agentDispatch"
  | "artifactAuthoring"
  | "cogniaCli"
  | "computerUse"
  | "goalRuntime"
  | "imBinding"
  | "ocr"
  | "pluginConversionTools"
  | "screenCapture"
  | "twinContext"
  | "webFetch"
  | "scheduler"
  | "webSearch"
  | "workflowEditorTools"
  | "workspace"
  | "workspaceBackend"
  | "workspaceRead"

export interface SkillCapabilityAvailability {
  available: boolean
  reason?: string
}

/** The only hand-written catalog/runtime translation. */
export const BUILT_IN_CAPABILITY_RUNTIME_KEYS: Readonly<
  Record<BuiltInSkillCapabilityId, RuntimeSkillCapability>
> = {
  "agent-dispatch": "agentDispatch",
  "artifact-authoring": "artifactAuthoring",
  "cognia-cli": "cogniaCli",
  "computer-use": "computerUse",
  "goal-runtime": "goalRuntime",
  "im-binding": "imBinding",
  ocr: "ocr",
  "plugin-conversion-tools": "pluginConversionTools",
  scheduler: "scheduler",
  "screen-capture": "screenCapture",
  "twin-context": "twinContext",
  "web-fetch": "webFetch",
  "web-search": "webSearch",
  "workflow-editor-tools": "workflowEditorTools",
  workspace: "workspace",
  "workspace-backend": "workspaceBackend",
  "workspace-read": "workspaceRead",
}

export interface ResolvedBuiltInSkill {
  bundleId: string
  canonicalId: string
  storageId: string
  delivery: BuiltInSkillDelivery
  entry: BuiltInSkillCatalogEntry
}

export interface UnavailableBuiltInSkill {
  bundleId: string
  canonicalId: string
  reason: string
}

export interface ResolveSkillDeliveryRequest {
  surfaces?: Iterable<string>
  intents?: Iterable<string>
  capabilities?: Partial<Record<RuntimeSkillCapability, SkillCapabilityAvailability>>
  skillStates?: Readonly<Record<string, SkillStatus>>
  explicitSkillIds?: Iterable<string>
  requestScopedSkillIds?: Iterable<string>
  surfaceSkillsEnabled?: boolean
}

export interface ResolvedSkillDelivery {
  /**
   * Host policies named by every descriptor whose triggers matched, whether or
   * not its guidance was delivered. That is deliberate and pinned by
   * `delivery.test.ts`: a policy like `host-consent` or `pii-gate` describes
   * the SURFACE the turn is running on, so disabling a Skill's guidance text
   * must not also drop the constraint that text was explaining.
   *
   * DORMANT: nothing reads this yet. Every policy it names is enforced by its
   * own owner today (`lib/policy/risk/`, the automation consent gate,
   * `packages/redact`), so this is a description for a future consumer, not a
   * second enforcement point. Do not enforce from it without first deciding
   * what a policy from an undelivered Skill should mean.
   */
  hostPolicies: string[]
  injected: ResolvedBuiltInSkill[]
  catalog: ResolvedBuiltInSkill[]
  explicit: ResolvedBuiltInSkill[]
  requestScoped: ResolvedBuiltInSkill[]
  unavailable: UnavailableBuiltInSkill[]
  resourceSkillIds: string[]
}

/**
 * Project generated descriptor content into the legacy Skill row shape.
 *
 * Async because the body is no longer in the catalog: it is a per-skill chunk
 * this awaits. Only skills that are actually delivered reach here, which is the
 * point of the split.
 */
export async function builtInDescriptorSkill(
  resolved: ResolvedBuiltInSkill,
  status: SkillStatus = resolved.entry.defaultEnabled ? "enabled" : "disabled"
): Promise<Skill> {
  const content = await loadBuiltInSkillContent(resolved.bundleId)
  return {
    id: resolved.storageId,
    slug: resolved.bundleId,
    canonicalId: resolved.canonicalId,
    name: resolved.entry.name,
    description: resolved.entry.description,
    content,
    allowedTools: resolved.entry.allowedTools,
    tags: resolved.entry.tags,
    category: resolved.entry.category as SkillCategory | undefined,
    invocationPolicy: resolved.delivery === "explicit" ? "explicit" : "implicit",
    source: "builtin",
    isBuiltIn: true,
    status,
    createdAt: 0,
    updatedAt: 0,
  }
}

function normalizedIdSet(values: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>()
  for (const value of values ?? []) {
    const identity = resolveBuiltinSkillIdentity(value)
    if (identity) out.add(identity.bundleId)
  }
  return out
}

function normalizedStates(
  states: ResolveSkillDeliveryRequest["skillStates"]
): Map<string, SkillStatus> {
  const out = new Map<string, SkillStatus>()
  for (const [alias, state] of Object.entries(states ?? {})) {
    const identity = resolveBuiltinSkillIdentity(alias)
    if (identity) out.set(identity.bundleId, state)
  }
  return out
}

function defaultStatus(entry: BuiltInSkillCatalogEntry): SkillStatus {
  return entry.defaultEnabled ? "enabled" : "disabled"
}

function entryMatches(
  entry: BuiltInSkillCatalogEntry,
  surfaces: ReadonlySet<string>,
  intents: ReadonlySet<string>,
  explicitIds: ReadonlySet<string>,
  requestScopedIds: ReadonlySet<string>
): boolean {
  if (entry.delivery === "explicit") return explicitIds.has(entry.id)
  if (entry.delivery === "request-scoped") return requestScopedIds.has(entry.id)
  // A Skill the user pinned (character `skillIds` / an ad-hoc attachment) is
  // selected, not inferred: its descriptor triggers describe when to activate
  // it AUTOMATICALLY, so requiring one would silently drop a Skill the user
  // explicitly asked for on every surface the descriptor did not anticipate.
  return (
    explicitIds.has(entry.id) ||
    entry.triggers.surfaces.some((surface) => surfaces.has(surface)) ||
    entry.triggers.intents.some((intent) => intents.has(intent))
  )
}

function requirementApplies(
  requirement: BuiltInSkillCapabilityRequirement,
  intents: ReadonlySet<string>
): boolean {
  return requirement.whenIntent === undefined || intents.has(requirement.whenIntent)
}

function unavailableCapabilityReason(
  entry: BuiltInSkillCatalogEntry,
  intents: ReadonlySet<string>,
  capabilities: ResolveSkillDeliveryRequest["capabilities"]
): string | undefined {
  for (const requirement of entry.capabilityRequirements) {
    if (!requirementApplies(requirement, intents)) continue
    const runtimeKey = BUILT_IN_CAPABILITY_RUNTIME_KEYS[requirement.capability]
    if (!runtimeKey) return `No runtime mapping for capability ${requirement.capability}`
    const availability = capabilities?.[runtimeKey]
    if (!availability?.available) return availability?.reason ?? requirement.reason
  }
  return undefined
}

/**
 * Resolve prompt delivery without granting tools. Generated descriptors own
 * delivery, triggers, host policies, and resource roles.
 */
export function resolveSkillDelivery(request: ResolveSkillDeliveryRequest): ResolvedSkillDelivery {
  const surfaces = new Set(request.surfaces ?? [])
  const intents = new Set(request.intents ?? [])
  const states = normalizedStates(request.skillStates)
  const explicitIds = normalizedIdSet(request.explicitSkillIds)
  const requestScopedIds = normalizedIdSet(request.requestScopedSkillIds)
  const automaticEnabled = request.surfaceSkillsEnabled !== false
  const result: ResolvedSkillDelivery = {
    hostPolicies: [],
    injected: [],
    catalog: [],
    explicit: [],
    requestScoped: [],
    unavailable: [],
    resourceSkillIds: [],
  }
  const hostPolicies = new Set<string>()
  const resourceSkillIds = new Set<string>()

  for (const entry of BUILT_IN_SKILL_CATALOG) {
    if (!entryMatches(entry, surfaces, intents, explicitIds, requestScopedIds)) continue
    for (const hostPolicy of entry.hostPolicies) hostPolicies.add(hostPolicy)

    // `surfaceSkillsEnabled` turns off the AUTOMATIC, surface-inferred
    // activation. An entry the user pinned is not automatic, so the toggle
    // must not silently withhold it.
    if (
      (entry.delivery === "inject" || entry.delivery === "catalog") &&
      !automaticEnabled &&
      !explicitIds.has(entry.id)
    ) {
      continue
    }
    if (
      entry.delivery === "request-scoped" &&
      !entry.triggers.intents.some((intent) => intents.has(intent))
    ) {
      result.unavailable.push({
        bundleId: entry.id,
        canonicalId: entry.canonicalId,
        reason: "Request-scoped Skill requires a matching intent",
      })
      continue
    }
    const requestScoped = requestScopedIds.has(entry.id)
    const state = states.get(entry.id) ?? defaultStatus(entry)
    if (state !== "enabled" && !(entry.delivery === "request-scoped" && requestScoped)) {
      result.unavailable.push({
        bundleId: entry.id,
        canonicalId: entry.canonicalId,
        reason: state === "disabled" ? "Skill is disabled" : `Skill status is ${state}`,
      })
      continue
    }
    const capabilityReason = unavailableCapabilityReason(entry, intents, request.capabilities)
    if (capabilityReason) {
      result.unavailable.push({
        bundleId: entry.id,
        canonicalId: entry.canonicalId,
        reason: capabilityReason,
      })
      continue
    }

    const resolved: ResolvedBuiltInSkill = {
      bundleId: entry.id,
      canonicalId: entry.canonicalId,
      storageId: builtinSkillId(entry),
      delivery: entry.delivery,
      entry,
    }
    result[
      entry.delivery === "inject"
        ? "injected"
        : entry.delivery === "catalog"
          ? "catalog"
          : entry.delivery === "explicit"
            ? "explicit"
            : "requestScoped"
    ].push(resolved)
    if ((entry.resourceManifest?.length ?? 0) > 0) resourceSkillIds.add(resolved.storageId)
  }

  result.hostPolicies = [...hostPolicies]
  result.resourceSkillIds = [...resourceSkillIds]
  return result
}
