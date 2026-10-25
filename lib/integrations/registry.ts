import type {
  IntegrationAccountStatusProvider,
  IntegrationActionDef,
  IntegrationActionHandler,
  IntegrationEventNormalizer,
  IntegrationResourceProvider,
  PluginIntegrationDef,
} from "@/types/plugin/plugin-integration"

export interface RegisterIntegrationDefinitionsInput {
  pluginId: string
  definitions: readonly PluginIntegrationDef[]
  handlers: Record<string, IntegrationActionHandler>
  normalizers?: Record<string, IntegrationEventNormalizer>
  resourceProviders?: Record<string, IntegrationResourceProvider>
  accountStatusProviders?: Record<string, IntegrationAccountStatusProvider>
}

interface RegisteredIntegration {
  pluginId: string
  definition: PluginIntegrationDef
  handlers: Map<string, IntegrationActionHandler>
  normalizer?: IntegrationEventNormalizer
  resourceProvider?: IntegrationResourceProvider
  accountStatusProvider?: IntegrationAccountStatusProvider
}

const integrations = new Map<string, RegisteredIntegration>()
const listeners = new Set<() => void>()
let revision = 0

function emitRegistryChange(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeIntegrationRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getIntegrationRegistryRevision(): number {
  return revision
}

function registryKey(pluginId: string, integrationId: string): string {
  return `${pluginId}:${integrationId}`
}

export function registerIntegrationDefinitions(input: RegisterIntegrationDefinitionsInput): void {
  for (const definition of input.definitions) {
    const handlers = new Map<string, IntegrationActionHandler>()
    for (const action of definition.actions) {
      const handler = input.handlers[`${definition.id}:${action.id}`]
      if (!handler) {
        throw new Error(
          `Integration "${definition.id}" action "${action.id}" has no resolved handler`
        )
      }
      handlers.set(action.id, handler)
    }
    for (const projection of definition.inboxProjections ?? []) {
      const alias = projection.threadAlias
      // An alias names the thread identity its events join. Pointing at a
      // projection that does not exist would file them under a thread no
      // subscription can ever select, so refuse it at registration.
      if (
        alias &&
        !definition.inboxProjections?.some((candidate) => candidate.id === alias.projectionId)
      ) {
        throw new Error(
          `Integration "${definition.id}" projection "${projection.id}" aliases unknown projection "${alias.projectionId}"`
        )
      }
    }
    const normalizer = definition.ingress ? input.normalizers?.[definition.id] : undefined
    if (definition.ingress && !normalizer) {
      throw new Error(`Integration "${definition.id}" has no resolved ingress normalizer`)
    }
    const resourceProvider = definition.resourceProvider
      ? input.resourceProviders?.[definition.id]
      : undefined
    if (definition.resourceProvider && !resourceProvider) {
      throw new Error(`Integration "${definition.id}" has no resolved resource provider`)
    }
    const accountStatusProvider = definition.healthProvider
      ? input.accountStatusProviders?.[definition.id]
      : undefined
    if (definition.healthProvider && !accountStatusProvider) {
      throw new Error(`Integration "${definition.id}" has no resolved account status provider`)
    }
    integrations.set(registryKey(input.pluginId, definition.id), {
      pluginId: input.pluginId,
      definition,
      handlers,
      normalizer,
      resourceProvider,
      accountStatusProvider,
    })
  }
  if (input.definitions.length > 0) emitRegistryChange()
}

export function getRegisteredIntegration(
  pluginId: string,
  integrationId: string
): RegisteredIntegration | undefined {
  return integrations.get(registryKey(pluginId, integrationId))
}

export function listRegisteredIntegrations(pluginId?: string): PluginIntegrationDef[] {
  return [...integrations.values()]
    .filter((entry) => !pluginId || entry.pluginId === pluginId)
    .map((entry) => entry.definition)
}

export function listRegisteredIntegrationEntries(): Array<{
  pluginId: string
  definition: PluginIntegrationDef
}> {
  return [...integrations.values()].map(({ pluginId, definition }) => ({
    pluginId,
    definition,
  }))
}

function toolNamePart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

/**
 * The chat tool an integration action is registered as:
 * `integration__<plugin>__<integration>__<action>`, each part reduced to
 * `[a-z0-9_-]`. {@link findIntegrationActionsByToolName} reverses it.
 */
export function integrationToolName(
  pluginId: string,
  integrationId: string,
  actionId: string
): string {
  return ["integration", pluginId, integrationId, actionId].map(toolNamePart).join("__")
}

export interface RegisteredIntegrationAction {
  pluginId: string
  definition: PluginIntegrationDef
  action: IntegrationActionDef
}

/**
 * The registered actions a chat tool name calls, bare or as the model sees it
 * (`mcp__<server>__integration__…`). Usually one; reducing names to
 * `[a-z0-9_-]` can make two actions share a tool name, and then every one of
 * them is returned so a caller can judge the riskiest.
 */
export function findIntegrationActionsByToolName(toolName: string): RegisteredIntegrationAction[] {
  const parts = toolName.split("__")
  if (parts.length < 4 || parts[parts.length - 4].toLowerCase() !== "integration") return []
  const name = parts.slice(-4).join("__").toLowerCase()
  const found: RegisteredIntegrationAction[] = []
  for (const { pluginId, definition } of integrations.values()) {
    for (const action of definition.actions) {
      if (integrationToolName(pluginId, definition.id, action.id) === name) {
        found.push({ pluginId, definition, action })
      }
    }
  }
  return found
}

export function getIntegrationActionHandler(
  pluginId: string,
  integrationId: string,
  actionId: string
): IntegrationActionHandler | undefined {
  return getRegisteredIntegration(pluginId, integrationId)?.handlers.get(actionId)
}

export function getIntegrationEventNormalizer(
  pluginId: string,
  integrationId: string
): IntegrationEventNormalizer | undefined {
  return getRegisteredIntegration(pluginId, integrationId)?.normalizer
}

export function getIntegrationResourceProvider(
  pluginId: string,
  integrationId: string
): IntegrationResourceProvider | undefined {
  return getRegisteredIntegration(pluginId, integrationId)?.resourceProvider
}

export function getIntegrationAccountStatusProvider(
  pluginId: string,
  integrationId: string
): IntegrationAccountStatusProvider | undefined {
  return getRegisteredIntegration(pluginId, integrationId)?.accountStatusProvider
}

export function unregisterIntegrationsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [key, entry] of integrations) {
    if (entry.pluginId !== pluginId) continue
    integrations.delete(key)
    removed += 1
  }
  if (removed > 0) emitRegistryChange()
  return removed
}

export function __resetIntegrationRegistryForTesting(): void {
  const changed = integrations.size > 0
  integrations.clear()
  if (changed) emitRegistryChange()
}
