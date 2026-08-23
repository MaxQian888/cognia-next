import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

import { matchesToolPattern } from "@/lib/mcp/tool-rules"
import { getExternalService, registerExternalCapabilities } from "../catalog"

export function projectManagedMcpCapabilities(
  server: McpServer,
  discovery: Pick<McpCapabilityCacheRow, "tools" | "resources" | "prompts">
): boolean {
  const managed = server.managedBy
  if (!managed) return false
  const service = getExternalService(managed.pluginId, managed.serviceId)
  const provider = service?.definition.providers.find(
    (candidate) => candidate.id === managed.providerId && candidate.kind === "mcp"
  )
  if (!provider) return false

  const capabilities = discovery.tools.flatMap((tool) => {
    const rule = server.toolRiskRules?.find((candidate) =>
      matchesToolPattern(tool.name, candidate.pattern)
    )
    const entries = [
      {
        pluginId: managed.pluginId,
        serviceId: managed.serviceId,
        providerId: managed.providerId,
        capabilityId: tool.name,
        operationId: rule?.operationId ?? `${managed.serviceId}.${tool.name}`,
        kind: "tool" as const,
        risk: rule?.risk ?? ("write" as const),
        policyKnown: Boolean(rule),
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : undefined,
        outputSchema:
          tool.outputSchema && typeof tool.outputSchema === "object"
            ? (tool.outputSchema as Record<string, unknown>)
            : undefined,
        scopeSelectors: rule?.selectors,
        surfaces: provider.surfaces,
      },
    ]
    const ui = tool._meta?.ui
    if (
      ui &&
      typeof ui === "object" &&
      typeof (ui as Record<string, unknown>).resourceUri === "string"
    ) {
      entries.push({
        pluginId: managed.pluginId,
        serviceId: managed.serviceId,
        providerId: managed.providerId,
        capabilityId: `ui:${tool.name}`,
        kind: "ui" as const,
        risk: "read" as const,
        policyKnown: true,
        inputSchema: undefined,
        outputSchema: undefined,
        scopeSelectors: undefined,
        operationId: undefined,
        surfaces: provider.surfaces,
      })
    }
    return entries
  })
  for (const resource of discovery.resources) {
    capabilities.push({
      pluginId: managed.pluginId,
      serviceId: managed.serviceId,
      providerId: managed.providerId,
      capabilityId: resource.uri,
      kind: "resource",
      risk: "read",
      policyKnown: true,
      inputSchema: undefined,
      outputSchema: undefined,
      scopeSelectors: undefined,
      operationId: undefined,
      surfaces: provider.surfaces,
    })
  }
  for (const prompt of discovery.prompts) {
    capabilities.push({
      pluginId: managed.pluginId,
      serviceId: managed.serviceId,
      providerId: managed.providerId,
      capabilityId: prompt.name,
      kind: "prompt",
      risk: "read",
      policyKnown: true,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          (prompt.arguments ?? []).map((argument) => [
            argument.name,
            { type: "string", description: argument.description },
          ])
        ),
        required: (prompt.arguments ?? [])
          .filter((argument) => argument.required)
          .map((argument) => argument.name),
        additionalProperties: false,
      },
      outputSchema: undefined,
      scopeSelectors: undefined,
      operationId: undefined,
      surfaces: provider.surfaces,
    })
  }
  registerExternalCapabilities(
    managed.pluginId,
    managed.serviceId,
    managed.providerId,
    capabilities
  )
  return true
}
