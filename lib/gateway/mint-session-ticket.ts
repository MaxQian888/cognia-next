/**
 * Mint the session-scoped route ticket a gateway-routed execution spec needs
 * (ADR-0090 Phase 2).
 *
 * Everything around this existed already and did nothing: the Rust commands,
 * the `gatewayAgentRouteTickets` flag, `sendSpecFromResolved`'s `gateway`
 * parameter, the settings panel that lists and revokes tickets, and the
 * sidecar's `validateRouteEnv` invariant. What was missing was an issuer — no
 * call site anywhere reached `gatewayMintRouteTicket`, so `route.kind` resolved
 * to `"gateway"` and then silently degraded to `direct` on the wire, and the
 * ticket list could never be anything but empty.
 *
 * The secret is returned ONCE and is never persisted: the caller stamps it into
 * `SendOptions.env.ANTHROPIC_API_KEY` alongside `ANTHROPIC_BASE_URL` (the
 * endpoint), which is exactly the shape `sidecar/dispatch/subprocess-env.mjs`
 * validates.
 */

import { getAllProviders } from "@cognia/provider-types/provider"
import { resolveProviderProtocol } from "@/sidecar/dispatch/protocol-adapters/provider-protocol.mjs"
import { isAgentExecutionFlagEnabled } from "@/lib/ai/agent/execution/feature-flags"
import {
  gatewayGetStatus,
  gatewayMintRouteTicket,
  gatewayPushSnapshot,
  gatewayRevokeRouteTicket,
  gatewayStart,
} from "@/lib/tauri/gateway"
import type { GatewayRoutingSnapshot, GatewayModelMetadata } from "@/types/gateway"

export interface MintSessionTicketInput {
  sessionId: string
  parentSessionId?: string
  executionFingerprint: string
  /** The model the turn will ask for — decides which candidates are frozen. */
  model: string
  routePolicy: string
}

export interface MintedSessionTicket {
  /** OpenAI-compatible base URL of the local listener. */
  endpoint: string
  ticketId: string
  /** Shown once. Stamp into the subprocess env and drop. */
  secret: string
}

/**
 * Candidates the gateway can actually serve for `model`, ordered.
 *
 * Mint rejects any candidate the current snapshot cannot serve
 * (`TicketError::UnknownCandidate`), so this resolves against the same
 * snapshot the provider publishes rather than guessing. An alias contributes
 * its ordered entries; a bare / `provider:model` id falls back to whichever
 * enabled providers list it.
 */
export function candidatesForModel(
  snapshot: GatewayRoutingSnapshot,
  model: string
): Array<{ deploymentId: string; modelId: string }> {
  const deploymentFor = (providerId: string): string | undefined =>
    snapshot.providers.find((provider) => provider.id === providerId)?.deploymentId ?? providerId

  const alias = snapshot.aliases.find((entry) => entry.alias === model)
  if (alias) {
    return alias.entries.flatMap((entry) => {
      const deploymentId = deploymentFor(entry.providerId)
      return deploymentId ? [{ deploymentId, modelId: entry.modelId }] : []
    })
  }

  // Match the longest registered prefix: plugin provider ids themselves
  // contain colons, and a model id may contain them too.
  const pinned = snapshot.providers
    .filter((provider) => model.startsWith(`${provider.id}:`))
    .sort((a, b) => b.id.length - a.id.length)[0]
  const bareModel = pinned ? model.slice(pinned.id.length + 1) : model
  return snapshot.providers.flatMap((provider) => {
    if (!provider.enabled || (pinned && provider.id !== pinned.id)) return []
    if (!provider.models.includes(bareModel)) return []
    return [{ deploymentId: provider.deploymentId ?? provider.id, modelId: bareModel }]
  })
}

/** `loopback` binds 127.0.0.1; `lan` still answers there, so both dial local. */
function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/**
 * Returns `undefined` — never throws — when a ticket cannot be minted: the flag
 * is off, the listener is not running, the snapshot cannot serve the model, or
 * Rust refused. The caller then sends the `direct` wire shape, which is the
 * pre-existing behavior. Failing the whole turn over an optional route freeze
 * would be a worse trade.
 */
export async function mintSessionRouteTicket(
  input: MintSessionTicketInput
): Promise<MintedSessionTicket | undefined> {
  if (!isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")) return undefined

  try {
    const status = await gatewayGetStatus()
    if (!status.running || status.boundPort === null) return undefined

    const { buildGatewaySnapshot, loadSnapshotProfileMeta } =
      await import("@/lib/gateway/snapshot-publisher")
    const { useSettingsStore } = await import("@/stores/settings")
    const live = useSettingsStore.getState().settings
    if (!live) return undefined

    const profileMeta = await loadSnapshotProfileMeta().catch(() => undefined)
    const snapshot = buildGatewaySnapshot(
      {
        defaultProvider: live.defaultProvider,
        providerSettings: live.providerSettings,
        customProviders: live.customProviders,
        modelMappings: live.modelMappings,
        routingConfig: live.routingConfig,
      },
      Date.now(),
      profileMeta
    )

    const candidates = candidatesForModel(snapshot, input.model)
    if (candidates.length === 0) return undefined

    const minted = await gatewayMintRouteTicket({
      sessionId: input.sessionId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      executionFingerprint: input.executionFingerprint,
      candidates,
      // No `modelBindings` on purpose: Rust's `default_model_bindings` binds
      // `primary` and the sonnet/haiku/opus family selectors from `model`, so
      // there is exactly one implementation of that mapping. Claude Code's
      // first background (haiku) turn used to 400 because nothing bound it.
      model: input.model,
      // More than one candidate means failover is possible, so the ticket must
      // permit moving off the first credential; a single candidate stays stuck
      // to its own.
      credentialAffinity: candidates.length > 1 ? "sticky-with-failover" : "session-sticky",
      allowAuthFailover: candidates.length > 1,
      routePolicy: input.routePolicy,
    })

    return {
      endpoint: endpointFor(status.boundPort),
      ticketId: minted.ticket.ticketId,
      secret: minted.secret,
    }
  } catch {
    return undefined
  }
}

export interface ExternalAgentGatewayRouteInput {
  providerId: string
  modelId: string
  accountId?: string | null
  sessionId: string
  executionFingerprint?: string
  ingressProtocol?: "openai-chat" | "openai-responses" | "anthropic"
  signal?: AbortSignal
}

/**
 * Prepare a required, task-isolated gateway lease. The ordinary snapshot is
 * published first; an explicitly selected account lives only in the ticket's
 * private provider override and never changes another task's account.
 */
export async function prepareExternalAgentGatewayRoute(
  input: ExternalAgentGatewayRouteInput
): Promise<
  MintedSessionTicket & {
    model: string
    modelMetadata: GatewayModelMetadata
    ownerAccountId: string | null
    binding: { providerId: string; modelId: string; accountId: string | null }
  }
> {
  if (!input.providerId.trim() || !input.modelId.trim() || !input.sessionId.trim())
    throw new Error("A provider, model and task session are required for the Cognia gateway")
  const [
    { useSettingsStore },
    { useAccountStore },
    publisher,
    { resolveSubscriptionProviderCredential },
  ] = await Promise.all([
    import("@/stores/settings"),
    import("@/stores/account/account-store"),
    import("@/lib/gateway/snapshot-publisher"),
    import("@/lib/claude/provider-attempt-options"),
  ])
  const settings = useSettingsStore.getState().settings
  if (!settings) throw new Error("Cognia provider settings are unavailable")
  const ownerAccountId = useAccountStore.getState().unlockedAccountId
  const { getSubscriptionProvider } = await import("@/lib/subscription/core/provider-registry")
  const definition = getSubscriptionProvider(input.providerId, settings.customProviders)
  const configured =
    settings.customProviders?.find((provider) => provider.id === input.providerId) ??
    settings.providerSettings?.[input.providerId]
  const allowsUnauthenticated = getAllProviders()[input.providerId]?.apiKeyRequired === false
  const hasManualCredential = Boolean(
    configured?.apiKey?.trim() || configured?.apiKeys?.some((key) => key.trim())
  )
  let accountId = input.accountId
  if (accountId === undefined) {
    if (hasManualCredential) accountId = null
    else if (definition && definition.authMode !== "anthropic-oauth") {
      const { getActiveAccount } = await import("@/lib/subscription/core/transport")
      accountId =
        settings.defaultAccountIds?.[definition.id] ??
        (settings.defaultProvider === input.providerId || settings.defaultProvider === definition.id
          ? settings.defaultAccountId
          : undefined) ??
        (await getActiveAccount(definition.id)).activeAccountId
    } else accountId = null
  }
  if (!accountId && !hasManualCredential && !allowsUnauthenticated)
    throw new Error("The selected Cognia model has no usable gateway credential")
  const assertCurrent = () => {
    input.signal?.throwIfAborted()
    if (
      useAccountStore.getState().unlockedAccountId !== ownerAccountId ||
      useSettingsStore.getState().settings !== settings
    )
      throw new Error("Cognia account or model settings changed while preparing the task")
  }
  assertCurrent()
  let status = await gatewayGetStatus()
  if (status.accountRequired && (!ownerAccountId || status.ownerAccountId !== ownerAccountId))
    throw new Error("Unlock the Cognia account before starting the gateway task")
  const accountGeneration = status.accountGeneration
  if (!status.running) {
    await gatewayStart()
    status = await gatewayGetStatus()
  }
  assertCurrent()
  if (!status.running || status.boundPort === null)
    throw new Error("The Cognia gateway listener is unavailable")
  if (
    status.accountGeneration !== accountGeneration ||
    (status.accountRequired && status.ownerAccountId !== ownerAccountId)
  )
    throw new Error("Cognia account changed while starting the gateway")
  const profileMeta = await publisher.loadSnapshotProfileMeta()
  const snapshot = await publisher.buildEnrichedGatewaySnapshot(settings, Date.now(), profileMeta)
  assertCurrent()
  const provider = snapshot.providers.find((entry) => entry.id === input.providerId)
  if (!provider || provider.credentialFallbackAllowed === false)
    throw new Error("The selected Cognia provider is unavailable or disabled")
  let upstream = { ...provider }
  if (accountId) {
    const credential = await resolveSubscriptionProviderCredential(
      input.providerId,
      settings,
      accountId
    )
    assertCurrent()
    if (!credential) throw new Error("The selected Cognia subscription account is unavailable")
    upstream = {
      ...upstream,
      apiKey: credential.apiKey,
      apiKeys: undefined,
      rotationEnabled: false,
      rotationStrategy: undefined,
      baseUrl: credential.baseURL,
      protocol: credential.protocol ?? upstream.protocol,
      apiFlavor: credential.apiFlavor ?? upstream.apiFlavor,
      enabled: true,
      transport: {
        ...upstream.transport,
        authScheme:
          (credential.protocol ?? upstream.protocol) === "anthropic" ? "x-api-key" : "bearer",
        staticHeaders: Object.entries(credential.headers ?? {}),
      },
    }
  }
  // CommandCode serves different model families through different protocols.
  // Freeze the shared resolver's decision before replacing the provider id
  // with a task deployment id, which cannot identify the original provider.
  if (input.providerId === "commandcode") {
    const protocol = resolveProviderProtocol(input.providerId, input.modelId) as
      "openai" | "anthropic"
    upstream = {
      ...upstream,
      protocol,
      transport: {
        ...upstream.transport,
        authScheme: protocol === "anthropic" ? "x-api-key" : "bearer",
      },
    }
  }
  if (
    !upstream.enabled ||
    !upstream.baseUrl ||
    (!upstream.apiKey && !upstream.apiKeys?.length && !allowsUnauthenticated)
  )
    throw new Error("The selected Cognia model has no usable gateway credential")
  if (upstream.protocol !== "openai" && upstream.protocol !== "anthropic")
    throw new Error(
      "The selected provider protocol cannot serve this external agent through the gateway"
    )
  let modelAvailable = upstream.models.includes(input.modelId)
  // Per-provider discovery may describe a different subscription account.
  // Resolve selected-account facts transiently, without changing the picker or
  // another task's metadata. Unknown limits fall back to the declaration only.
  let metadataSettings = settings
  if (accountId) {
    metadataSettings = {
      ...settings,
      providerSettings: {
        ...settings.providerSettings,
        [input.providerId]: {
          ...settings.providerSettings?.[input.providerId],
          providerId: input.providerId,
          defaultModel: input.modelId,
          enabled: true,
          discoveredModels: [],
        },
      },
      customProviders: settings.customProviders?.map((entry) =>
        entry.id === input.providerId ? { ...entry, discoveredModels: [] } : entry
      ),
    }
    const { getSubscriptionModel } = await import("@/lib/subscription/core/model-discovery")
    if (definition?.modelApi?.list || definition?.modelApi?.retrieve) {
      const detail = await getSubscriptionModel({
        definition,
        accountId,
        model: input.modelId,
        signal: input.signal,
      })
      assertCurrent()
      if (!detail.model)
        throw new Error("The selected subscription account does not provide this model")
      modelAvailable = true
      const discoveredModels = [detail.model]
      metadataSettings = {
        ...metadataSettings,
        providerSettings: {
          ...metadataSettings.providerSettings,
          [input.providerId]: {
            ...metadataSettings.providerSettings?.[input.providerId],
            providerId: input.providerId,
            defaultModel: input.modelId,
            enabled: true,
            discoveredModels,
          },
        },
        customProviders: metadataSettings.customProviders?.map((entry) =>
          entry.id === input.providerId ? { ...entry, discoveredModels } : entry
        ),
      }
    }
  }
  if (!modelAvailable)
    throw new Error("The selected model is unavailable in the Cognia provider catalog")
  const modelMetadata = publisher.gatewayModelMetadata(
    metadataSettings,
    input.providerId,
    input.modelId
  )
  const pushed = await gatewayPushSnapshot(
    snapshot,
    ownerAccountId ? { ownerAccountId, accountGeneration } : undefined
  )
  assertCurrent()
  if (!pushed?.accepted)
    throw new Error("The Cognia gateway rejected the current provider snapshot")
  const deploymentId = `cognia-task-${crypto.randomUUID()}`
  const taskProvider = {
    ...upstream,
    id: deploymentId,
    deploymentId,
    models: [input.modelId],
    modelMetadata: [modelMetadata],
  }
  const minted = await gatewayMintRouteTicket(
    {
      sessionId: input.sessionId,
      executionFingerprint: input.executionFingerprint ?? deploymentId,
      candidates: [{ deploymentId, modelId: input.modelId }],
      providerOverrides: [taskProvider],
      model: input.modelId,
      modelBindings: Object.fromEntries(
        [input.modelId, "primary", "fast", "powerful", "sonnet", "haiku", "opus"].map(
          (selector) => [selector, input.modelId]
        )
      ),
      credentialAffinity: "session-sticky",
      allowAuthFailover: false,
      routePolicy: "gateway-required",
      operations: [
        input.ingressProtocol === "openai-responses" ? "responses" : "chat",
        "models",
        "count-tokens",
      ],
    },
    { required: true }
  )
  try {
    assertCurrent()
    const after = await gatewayGetStatus()
    if (
      after.accountGeneration !== accountGeneration ||
      !after.running ||
      after.boundPort !== status.boundPort
    )
      throw new Error("Cognia gateway ownership changed while preparing the task")
    assertCurrent()
    return {
      endpoint: endpointFor(status.boundPort),
      ticketId: minted.ticket.ticketId,
      secret: minted.secret,
      model: input.modelId,
      modelMetadata,
      ownerAccountId: ownerAccountId ?? null,
      binding: {
        providerId: input.providerId,
        modelId: input.modelId,
        accountId: accountId ?? null,
      },
    }
  } catch (error) {
    await gatewayRevokeRouteTicket(minted.ticket.ticketId)
    throw error
  }
}
