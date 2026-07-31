import type {
  IntegrationActionHandler,
  IntegrationEventNormalizer,
  PluginIntegrationDef,
} from "@/types/plugin/plugin-integration"
import type { PluginManifest } from "@/types/plugin/plugin"
import { createWorkflowAPI } from "@/lib/plugin/core/context"
import {
  registerIntegrationDefinitions,
  unregisterIntegrationsByPlugin,
} from "@/lib/integrations/registry"
import { executeIntegrationAction } from "@/lib/integrations/action-runner"
import {
  registerWorkflowKindAliases,
  unregisterWorkflowKindAliases,
} from "@/lib/workflow/definition/kind-aliases"

const workflowDisposers = new Map<string, Array<() => void>>()

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
  moduleExports: Record<string, unknown>
): Promise<void> {
  const definitions = manifest.integrations ?? []
  if (definitions.length === 0) return
  await unregisterIntegrationsForPlugin(pluginId)

  const handlers: Record<string, IntegrationActionHandler> = {}
  const normalizers: Record<string, IntegrationEventNormalizer> = {}
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
  }
  registerIntegrationDefinitions({ pluginId, definitions, handlers, normalizers })
  registerWorkflowKindAliases(pluginId, manifest.workflowKindAliases ?? {})

  const workflow = createWorkflowAPI(pluginId)
  const disposers: Array<() => void> = []
  for (const definition of definitions) {
    for (const action of definition.actions) {
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
            return { output: job }
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
