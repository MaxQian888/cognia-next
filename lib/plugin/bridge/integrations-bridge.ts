import type {
  IntegrationAccountStatusProvider,
  IntegrationActionHandler,
  IntegrationEventNormalizer,
  IntegrationResourceProvider,
  PluginIntegrationDef,
} from "@/types/plugin/plugin-integration"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginTool, PluginToolContext } from "@/types/plugin/plugin"
import { createWorkflowAPI } from "@/lib/plugin/core/context"
import {
  registerIntegrationDefinitions,
  unregisterIntegrationsByPlugin,
} from "@/lib/integrations/registry"
import {
  approveIntegrationActionJob,
  executeIntegrationAction,
} from "@/lib/integrations/action-runner"
import {
  registerWorkflowKindAliases,
  unregisterWorkflowKindAliases,
} from "@/lib/workflow/definition/kind-aliases"
import { listExternalCapabilities, listExternalServices } from "@/lib/external-services/catalog"
import {
  authorizeExternalCapability,
  extractCapabilityResourceScopes,
} from "@/lib/external-services/grants"
import { listCapabilityGrants, listServiceConnections } from "@/lib/db/external-services"

const workflowDisposers = new Map<string, Array<() => void>>()

function toolNamePart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

async function authorizeIntegrationAction(input: {
  pluginId: string
  integrationId: string
  actionId: string
  accountId: string
  args: Record<string, unknown>
  surface: "chat" | "workflow"
  interactive: boolean
  sessionId?: string
  workflowId?: string
}): Promise<ReturnType<typeof authorizeExternalCapability>> {
  const service = listExternalServices(input.pluginId).find((candidate) =>
    candidate.definition.providers.some(
      (provider) =>
        provider.kind === "integration" && provider.contributionId === input.integrationId
    )
  )
  const provider = service?.definition.providers.find(
    (candidate) =>
      candidate.kind === "integration" && candidate.contributionId === input.integrationId
  )
  const capability =
    service && provider
      ? listExternalCapabilities({
          pluginId: input.pluginId,
          serviceId: service.definition.id,
          providerId: provider.id,
        }).find((candidate) => candidate.capabilityId === input.actionId)
      : undefined
  const connection = (await listServiceConnections({ pluginId: input.pluginId })).find(
    (candidate) =>
      candidate.providerRef.kind === "integration" &&
      candidate.providerRef.accountId === input.accountId &&
      candidate.serviceId === service?.definition.id &&
      candidate.providerId === provider?.id
  )
  if (!connection) {
    return { decision: "deny", reason: "connection-unavailable" }
  }
  const extracted = capability
    ? extractCapabilityResourceScopes(capability, input.args)
    : { ok: false as const, reason: "Unknown capability" }
  if (!extracted.ok && (capability?.scopeSelectors?.length ?? 0) > 0) {
    return { decision: "deny", reason: "grant-required" }
  }
  return authorizeExternalCapability({
    capability,
    connection,
    grants: await listCapabilityGrants(connection.id),
    context: {
      interactive: input.interactive,
      surface: input.surface,
      accountId: input.accountId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      resourceScopes: extracted.ok ? extracted.scopes : [],
    },
  })
}

function actionParamsSchema(action: PluginIntegrationDef["actions"][number]) {
  const input = action.inputSchema
  const properties =
    input.properties && typeof input.properties === "object"
      ? (input.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(input.required)
    ? input.required.filter((value): value is string => typeof value === "string")
    : []
  return {
    type: "object",
    properties: {
      accountId: { type: "string", description: "Integration account id" },
      idempotencyKey: { type: "string", description: "Stable retry/deduplication key" },
      ...properties,
    },
    required: ["accountId", ...required],
  }
}

export async function registerIntegrationsForPlugin(
  pluginId: string,
  manifest: PluginManifest,
  moduleExports: Record<string, unknown>,
  registerAgentTool?: (tool: PluginTool) => () => void
): Promise<void> {
  const definitions = manifest.integrations ?? []
  if (definitions.length === 0) return
  await unregisterIntegrationsForPlugin(pluginId)

  const handlers: Record<string, IntegrationActionHandler> = {}
  const normalizers: Record<string, IntegrationEventNormalizer> = {}
  const resourceProviders: Record<string, IntegrationResourceProvider> = {}
  const accountStatusProviders: Record<string, IntegrationAccountStatusProvider> = {}
  for (const definition of definitions) {
    for (const action of definition.actions) {
      const candidate = moduleExports[action.handler]
      if (typeof candidate !== "function") {
        throw new Error(
          `Integration "${definition.id}" action "${action.id}" handler export "${action.handler}" was not found`
        )
      }
      handlers[`${definition.id}:${action.id}`] = candidate as IntegrationActionHandler
    }
    if (definition.ingress) {
      const candidate = moduleExports[definition.ingress.normalizer]
      if (typeof candidate !== "function") {
        throw new Error(
          `Integration "${definition.id}" normalizer export "${definition.ingress.normalizer}" was not found`
        )
      }
      normalizers[definition.id] = candidate as IntegrationEventNormalizer
    }
    if (definition.resourceProvider) {
      const candidate = moduleExports[definition.resourceProvider.handler]
      if (typeof candidate !== "function") {
        throw new Error(
          `Integration "${definition.id}" resource provider export "${definition.resourceProvider.handler}" was not found`
        )
      }
      resourceProviders[definition.id] = candidate as IntegrationResourceProvider
    }
    if (definition.healthProvider) {
      const candidate = moduleExports[definition.healthProvider.handler]
      if (typeof candidate !== "function") {
        throw new Error(
          `Integration "${definition.id}" health provider export "${definition.healthProvider.handler}" was not found`
        )
      }
      accountStatusProviders[definition.id] = candidate as IntegrationAccountStatusProvider
    }
  }
  registerIntegrationDefinitions({
    pluginId,
    definitions,
    handlers,
    normalizers,
    resourceProviders,
    accountStatusProviders,
  })
  registerWorkflowKindAliases(pluginId, manifest.workflowKindAliases ?? {})

  const workflow = createWorkflowAPI(pluginId)
  const disposers: Array<() => void> = []
  for (const definition of definitions) {
    for (const action of definition.actions) {
      if (registerAgentTool) {
        const toolName = ["integration", pluginId, definition.id, action.id]
          .map(toolNamePart)
          .join("__")
        disposers.push(
          registerAgentTool({
            name: toolName,
            pluginId,
            definition: {
              name: toolName,
              description: action.description ?? `${definition.label}: ${action.label}`,
              category: "integrations",
              requiresApproval: action.risk !== "read",
              retryable: action.idempotency !== "none",
              parametersSchema: actionParamsSchema(action),
            },
            execute: async (args: Record<string, unknown>, context: PluginToolContext) => {
              const { accountId, idempotencyKey, ...actionInput } = args
              if (typeof accountId !== "string" || accountId.length === 0) {
                throw new Error("Integration chat action requires accountId")
              }
              const authorization = await authorizeIntegrationAction({
                pluginId,
                integrationId: definition.id,
                actionId: action.id,
                accountId,
                args: actionInput,
                surface: "chat",
                interactive: true,
                sessionId: context.sessionId,
              })
              if (authorization.decision === "deny") {
                throw new Error(`Integration action denied: ${authorization.reason}`)
              }
              const job = await executeIntegrationAction(pluginId, {
                integrationId: definition.id,
                accountId,
                actionId: action.id,
                input: actionInput,
                idempotencyKey:
                  typeof idempotencyKey === "string" && idempotencyKey.length > 0
                    ? idempotencyKey
                    : action.idempotency === "none"
                      ? undefined
                      : `${context.sessionId ?? "chat"}:${action.id}`,
                source: "chat",
              })
              return authorization.decision === "allow" && job.status === "awaiting_approval"
                ? approveIntegrationActionJob(job.id)
                : job
            },
          })
        )
      }
      disposers.push(
        workflow.registerNode({
          kind: `action.${action.id}`,
          typeVersion: 1,
          category: "plugin",
          label: action.label,
          description: action.description ?? `${definition.label}: ${action.label}`,
          iconName: "Plug",
          keywords: [definition.id, ...definition.resourceKinds, action.risk],
          paramsSchema: actionParamsSchema(action),
          retryable: false,
          timeoutMs: action.timeoutMs,
          execute: async (context) => {
            const { accountId, idempotencyKey, ...actionInput } = context.params
            if (typeof accountId !== "string" || accountId.length === 0) {
              throw new Error("Integration workflow action requires accountId")
            }
            const authorization = await authorizeIntegrationAction({
              pluginId,
              integrationId: definition.id,
              actionId: action.id,
              accountId,
              args: actionInput,
              surface: "workflow",
              interactive: false,
              workflowId: context.workflowId,
            })
            if (authorization.decision !== "allow") {
              throw new Error(`Integration workflow action denied: ${authorization.reason}`)
            }
            const job = await executeIntegrationAction(pluginId, {
              integrationId: definition.id,
              accountId,
              actionId: action.id,
              input: actionInput,
              idempotencyKey:
                typeof idempotencyKey === "string" && idempotencyKey.length > 0
                  ? idempotencyKey
                  : action.idempotency === "none"
                    ? undefined
                    : `${context.runId}:${context.stepId}`,
              source: "workflow",
            })
            return {
              output:
                job.status === "awaiting_approval"
                  ? await approveIntegrationActionJob(job.id)
                  : job,
            }
          },
        })
      )
    }
  }
  workflowDisposers.set(pluginId, disposers)
}

export async function unregisterIntegrationsForPlugin(pluginId: string): Promise<void> {
  for (const dispose of workflowDisposers.get(pluginId) ?? []) dispose()
  workflowDisposers.delete(pluginId)
  unregisterWorkflowKindAliases(pluginId)
  unregisterIntegrationsByPlugin(pluginId)
}
