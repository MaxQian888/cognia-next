/**
 * Which Cognia provider models an external agent can run on through the
 * gateway (ADR-0090, 2026-09-11 and 2026-10-02 amendments).
 *
 * One eligibility rule, shared by the desktop's own model picker and the Host
 * command a paired phone or browser asks (`external_agent_cognia_models`). The
 * two used to be the same rule only by convention — the picker held it inline —
 * and a phone that listed a model the Host would refuse at task preparation is
 * a picker that lies. So the rule lives here, pure, and both read it.
 *
 * A model is eligible when the gateway can serve it to a task:
 *
 *   - its provider speaks OpenAI or Anthropic (the gateway's two upstream
 *     families for task tickets);
 *   - it is not explicitly known to lack tool calling or streaming (an agent
 *     cannot work without either; unknown stays eligible, the launch adapter
 *     re-checks);
 *   - the provider has a credential the gateway can use: a manual API key, an
 *     API-key subscription (whose accounts live in the vault), or no key
 *     requirement at all.
 *
 * The catalog this produces is for display and selection only. It carries
 * provider and model identifiers, names and capability facts — never a key,
 * a header or a base URL — because it crosses the wire to a paired device.
 */

import { piSubagentSupport } from "./pi-subagents"
import { getAllProviders } from "@cognia/provider-types/provider"
import type { CustomProviderSettings, UserProviderSettings } from "@cognia/provider-types/provider"
import type { AppSettings } from "@cognia/agent-config-types"
import { collectModelOptions, resolveModelMeta, type ModelOption } from "@/lib/ai/model-options"
import { reasoningTiersFor } from "@cognia/provider-core/providers/reasoning-tiers"
import type {
  AgentModelRoleOverrides,
  ExternalAgentCogniaModelBinding,
  ExternalAgentConfig,
} from "@/types/agent/external-agent"
import { gatewayModelSlots } from "./model-slots"
import { compileTaskModelPlan, type TaskModelPlanResult } from "./model-plan"
import { nativeSubagentModelBindings } from "./gateway-task"
import { overlayHostProviderKeys } from "@/lib/host-secrets/provider-key-store"
import { listSubscriptionProviders } from "@/lib/subscription/core/provider-registry"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

export interface CogniaGatewayModelOption {
  id: string
  name: string
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsStreaming?: boolean
}

export interface CogniaGatewayProviderOption {
  providerId: string
  providerName: string
  /** Vault account ids the Host can pin a task to. Ids only: no label, no email. */
  accountIds?: string[]
  models: CogniaGatewayModelOption[]
}

/**
 * Why a Host cannot offer Cognia models for one configuration.
 *
 *   - `host-update-required`: the Host predates `external_agent_cognia_models`.
 *   - `unsupported-runtime`: the configuration's runtime has no gateway launch
 *     contract (`cogniaGatewaySupport`).
 *   - `no-eligible-models`: the runtime is supported but no provider passes the
 *     eligibility rule above on that Host.
 *   - `account-locked`: the Host's Cognia account is locked, so its provider
 *     settings and vault cannot be read.
 *   - `public-https-required`: the gateway lease would have to cross a remote
 *     boundary, which only accepts public HTTPS upstreams.
 */
export type CogniaGatewayModelCatalogUnsupportedReason =
  | "host-update-required"
  | "unsupported-runtime"
  | "no-eligible-models"
  | "account-locked"
  | "public-https-required"

export type CogniaGatewayModelCatalog =
  | { supported: true; providers: CogniaGatewayProviderOption[] }
  | { supported: false; reason: CogniaGatewayModelCatalogUnsupportedReason }

export const COGNIA_GATEWAY_MODEL_CATALOG_REASONS: readonly CogniaGatewayModelCatalogUnsupportedReason[] =
  Object.freeze([
    "host-update-required",
    "unsupported-runtime",
    "no-eligible-models",
    "account-locked",
    "public-https-required",
  ])

type ProviderSettingsMap = Record<string, UserProviderSettings> | undefined

export interface CogniaGatewayModelFilterInput {
  providerSettings: ProviderSettingsMap
  customProviders: CustomProviderSettings[] | undefined
  /**
   * Registered subscription definitions. The picker passes its live hook value;
   * omitted, the registry is read for `customProviders`.
   */
  subscriptions?: readonly SubscriptionProviderDefinition[]
  /**
   * The catalog to enumerate and describe, when it differs from the stored one.
   * The picker narrows one provider's `discoveredModels` to a selected
   * subscription account; eligibility (protocol, credential) is still read from
   * the stored settings, which is what the gateway will resolve against.
   */
  scopedProviderSettings?: ProviderSettingsMap
  scopedCustomProviders?: CustomProviderSettings[] | undefined
}

function findSubscription(
  subscriptions: readonly SubscriptionProviderDefinition[],
  providerId: string
): SubscriptionProviderDefinition | undefined {
  return (
    subscriptions.find((entry) => entry.id === providerId) ??
    subscriptions.find((entry) => entry.plans?.some((plan) => plan.chatProviderId === providerId))
  )
}

/** The wire protocol a gateway provider speaks, read the way eligibility reads it. */
function gatewayProviderProtocol(
  providerId: string,
  input: {
    providerSettings?: CogniaGatewayModelFilterInput["providerSettings"]
    customProviders?: CustomProviderSettings[]
    subscriptions: readonly SubscriptionProviderDefinition[]
    catalog: ReturnType<typeof getAllProviders>
  }
): string | undefined {
  return (
    input.customProviders?.find((provider) => provider.id === providerId)?.apiProtocol ??
    input.providerSettings?.[providerId]?.apiProtocol ??
    input.catalog[providerId]?.protocol ??
    findSubscription(input.subscriptions, providerId)?.protocol
  )
}

/**
 * The flat, eligible model list in the picker's `ModelOption` shape (it groups
 * and renders these directly).
 */
export function filterCogniaGatewayModels(input: CogniaGatewayModelFilterInput): ModelOption[] {
  const { providerSettings, customProviders } = input
  // Keys a paired owner sealed on this host serve the gateway too (ADR-0224
  // A6): the run resolves them through the same overlay. Only ids and model
  // facts leave this function, never a key.
  const scopedSettings = overlayHostProviderKeys({
    ...(input.scopedProviderSettings ?? providerSettings),
  })
  const scopedCustomProviders = input.scopedCustomProviders ?? customProviders
  const subscriptions = input.subscriptions ?? listSubscriptionProviders(customProviders ?? [])
  const catalog = getAllProviders()
  return collectModelOptions(scopedSettings, scopedCustomProviders).filter((model) => {
    const custom = customProviders?.find((provider) => provider.id === model.providerId)
    const provider = catalog[model.providerId]
    const subscription = findSubscription(subscriptions, model.providerId)
    const protocol = gatewayProviderProtocol(model.providerId, {
      providerSettings,
      customProviders,
      subscriptions,
      catalog,
    })
    const metadata = resolveModelMeta(
      model.providerId,
      model.modelId,
      scopedSettings,
      scopedCustomProviders
    )
    const settings = custom ?? providerSettings?.[model.providerId]
    const hasManualKey =
      !!(settings?.apiKey || settings?.apiKeys?.some((key) => key.trim())) ||
      (!custom && !!scopedSettings[model.providerId]?.apiKey?.trim())
    return (
      (protocol === "openai" || protocol === "anthropic") &&
      metadata.supportsTools !== false &&
      metadata.supportsStreaming !== false &&
      (subscription?.authMode === "api-key" || hasManualKey || provider?.apiKeyRequired === false)
    )
  })
}

export interface CogniaGatewayModelOptionsInput {
  settings: Pick<AppSettings, "providerSettings" | "customProviders">
  subscriptions?: readonly SubscriptionProviderDefinition[]
  /**
   * Vault account ids per provider id, as the Host lists them. Only providers
   * with at least one id carry `accountIds`; the rest resolve their default at
   * task start.
   */
  accountIds?: Readonly<Record<string, readonly string[]>>
}

const MODEL_FACTS = [
  "contextLength",
  "supportsTools",
  "supportsVision",
  "supportsReasoning",
  "supportsStreaming",
] as const

/**
 * The eligible models grouped by provider, in the wire shape a paired device
 * receives. Each field is copied by name, so nothing the settings carry beside
 * these facts — keys, headers, base URLs — can ride along.
 */
export function listCogniaGatewayModelOptions(
  input: CogniaGatewayModelOptionsInput
): CogniaGatewayProviderOption[] {
  const models = filterCogniaGatewayModels({
    providerSettings: input.settings.providerSettings as ProviderSettingsMap,
    customProviders: input.settings.customProviders as CustomProviderSettings[] | undefined,
    subscriptions: input.subscriptions,
  })
  const providers = new Map<string, CogniaGatewayProviderOption>()
  for (const model of models) {
    let group = providers.get(model.providerId)
    if (!group) {
      const accountIds = input.accountIds?.[model.providerId]?.filter(
        (id) => typeof id === "string" && id.length > 0
      )
      group = {
        providerId: model.providerId,
        providerName: model.providerName || model.providerId,
        ...(accountIds && accountIds.length > 0 ? { accountIds: [...accountIds] } : {}),
        models: [],
      }
      providers.set(model.providerId, group)
    }
    if (group.models.some((entry) => entry.id === model.modelId)) continue
    const option: CogniaGatewayModelOption = {
      id: model.modelId,
      name: model.modelName || model.modelId,
    }
    for (const fact of MODEL_FACTS) {
      const value = (model as Partial<Record<(typeof MODEL_FACTS)[number], unknown>>)[fact]
      if (fact === "contextLength") {
        if (typeof value === "number" && Number.isFinite(value) && value > 0)
          option.contextLength = value
      } else if (typeof value === "boolean") {
        option[fact] = value
      }
    }
    group.models.push(option)
  }
  return [...providers.values()]
}

/**
 * The parts of `cognia-server`'s redacted Provider Profile Store export
 * (`provider_profiles_list`) the catalog reads: display names only. The export
 * carries credential references, never values, and none of it is forwarded.
 */
export interface HostProfileStoreDocs {
  providerProfiles?: Array<{ id: string; displayName?: string; deploymentRefs?: string[] }>
  deploymentProfiles?: Array<{
    id: string
    providerRef?: string
    enabled?: boolean
    models?: Array<{ id: string; displayName?: string }>
  }>
}

/**
 * What the Host's gateway can serve (`gateway_provider_capabilities`): the
 * snapshot projected from the profile store, credentials already resolved in
 * Rust. Only the protocol, the enabled flag, the size of the credential pool
 * and the model ids are read.
 */
export interface HostGatewayCapabilities {
  snapshot?: boolean
  providers?: Array<{
    id: string
    protocol?: string
    enabled?: boolean
    credentialPool?: number
    models?: Array<{ id: string }>
  }>
}

/**
 * The headless Host's catalog: the same eligibility rule, read from the
 * gateway snapshot `agent_gateway_host_task_prepare` mints against rather than
 * from renderer settings the brain does not have. A provider is offered when
 * the gateway serves it, it speaks OpenAI or Anthropic, and the Host resolved a
 * credential for it; each model is one the deployment lists. Capability facts
 * the profile store does not record stay absent (unknown is eligible, and the
 * launch adapter re-checks).
 */
export function listHostProfileGatewayModelOptions(
  docs: HostProfileStoreDocs | null | undefined,
  capabilities: HostGatewayCapabilities | null | undefined
): CogniaGatewayProviderOption[] {
  if (!capabilities?.snapshot) return []
  const deployments = new Map((docs?.deploymentProfiles ?? []).map((entry) => [entry.id, entry]))
  const profiles = new Map((docs?.providerProfiles ?? []).map((entry) => [entry.id, entry]))
  const eligible = (capabilities.providers ?? []).filter(
    (provider) =>
      provider.enabled === true &&
      (provider.protocol === "openai" || provider.protocol === "anthropic") &&
      typeof provider.credentialPool === "number" &&
      provider.credentialPool > 0 &&
      deployments.get(provider.id)?.enabled !== false
  )
  const perProfile = new Map<string, number>()
  for (const provider of eligible) {
    const ref = deployments.get(provider.id)?.providerRef ?? provider.id
    perProfile.set(ref, (perProfile.get(ref) ?? 0) + 1)
  }
  const options: CogniaGatewayProviderOption[] = []
  for (const provider of eligible) {
    const deployment = deployments.get(provider.id)
    const profile = deployment?.providerRef ? profiles.get(deployment.providerRef) : undefined
    const baseName = profile?.displayName?.trim() || provider.id
    const shared = (perProfile.get(deployment?.providerRef ?? provider.id) ?? 0) > 1
    const models: CogniaGatewayModelOption[] = []
    for (const model of provider.models ?? []) {
      if (typeof model?.id !== "string" || !model.id) continue
      if (models.some((entry) => entry.id === model.id)) continue
      const declared = deployment?.models?.find((entry) => entry.id === model.id)
      models.push({ id: model.id, name: declared?.displayName?.trim() || model.id })
    }
    if (models.length === 0) continue
    options.push({
      providerId: provider.id,
      providerName: shared ? `${baseName} (${provider.id})` : baseName,
      models,
    })
  }
  return options
}

/** True for a well-formed catalog. Used by the client on whatever the Host sent. */
export function isCogniaGatewayModelCatalog(value: unknown): value is CogniaGatewayModelCatalog {
  if (!value || typeof value !== "object") return false
  const candidate = value as { supported?: unknown; providers?: unknown; reason?: unknown }
  if (candidate.supported === false) {
    return COGNIA_GATEWAY_MODEL_CATALOG_REASONS.includes(
      candidate.reason as CogniaGatewayModelCatalogUnsupportedReason
    )
  }
  if (candidate.supported !== true || !Array.isArray(candidate.providers)) return false
  return candidate.providers.every(
    (provider: unknown) =>
      !!provider &&
      typeof provider === "object" &&
      typeof (provider as CogniaGatewayProviderOption).providerId === "string" &&
      typeof (provider as CogniaGatewayProviderOption).providerName === "string" &&
      Array.isArray((provider as CogniaGatewayProviderOption).models) &&
      (provider as CogniaGatewayProviderOption).models.every(
        (model) =>
          !!model &&
          typeof model === "object" &&
          typeof model.id === "string" &&
          typeof model.name === "string"
      )
  )
}

/**
 * Model-level reasoning facts the plan compiler needs, from the same settings
 * the gateway resolves against. Reasoning support is strict: a model whose
 * support is unknown accepts no effort, because Codex validates the effort
 * against the levels the task's catalog declares for that model.
 */
export function cogniaModelReasoningFacts(
  providerId: string,
  input: Partial<
    Pick<CogniaGatewayModelFilterInput, "providerSettings" | "customProviders" | "subscriptions">
  >
): {
  modelSupportsReasoning: (modelId: string) => boolean
  modelEffortValues: (modelId: string) => readonly string[]
} {
  const settings = overlayHostProviderKeys({ ...input.providerSettings })
  const supports = (modelId: string) =>
    resolveModelMeta(providerId, modelId, settings, input.customProviders).supportsReasoning ===
    true
  const protocol = gatewayProviderProtocol(providerId, {
    providerSettings: input.providerSettings ?? {},
    customProviders: input.customProviders,
    subscriptions: input.subscriptions ?? listSubscriptionProviders(input.customProviders ?? []),
    catalog: getAllProviders(),
  })
  return {
    modelSupportsReasoning: supports,
    modelEffortValues: (modelId) =>
      reasoningTiersFor({ providerId, modelId, protocol, reasoning: supports(modelId) }),
  }
}

/**
 * What an editor saves must be what admission will run: the same slots, the
 * same layer order and the same model facts. A subagent template passes its
 * pinned configuration's overrides as the lower layer.
 */
export function compileEditorModelPlan(input: {
  config: Pick<ExternalAgentConfig, "protocol" | "transport" | "process" | "metadata" | "network">
  primary: ExternalAgentCogniaModelBinding
  layers: readonly { source: "call" | "subagent" | "config"; overrides?: AgentModelRoleOverrides }[]
  providerSettings?: CogniaGatewayModelFilterInput["providerSettings"]
  customProviders?: CustomProviderSettings[]
  subscriptions?: readonly SubscriptionProviderDefinition[]
}): TaskModelPlanResult {
  return compileTaskModelPlan({
    primary: input.primary,
    explicitModels: nativeSubagentModelBindings(input.config, input.primary),
    // Editor checks are synchronous. Pi discovery is host I/O, repeated by
    // host-config-service before save and manager before minting a task.
    // Validate the role shape here; only a detected plugin exposes the UI row.
    slots:
      input.config.protocol === "pi-rpc" && !piSubagentSupport(input.config)
        ? [{ id: "subagent.default", kind: "child-default", evidence: "pending host Pi discovery" }]
        : gatewayModelSlots(input.config),
    layers: input.layers,
    ...cogniaModelReasoningFacts(input.primary.providerId, input),
  })
}
