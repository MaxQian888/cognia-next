import type { McpCapabilityCacheRow, McpServer } from "@cognia/agent-config-types"

import {
  DocsProviderError,
  getDocsProvider,
  registerDocsProvider,
  unregisterDocsProvider,
  type DocsProvider,
  type RemoteDocContent,
} from "@/lib/docs-providers"
import { resolveMcpSecrets } from "@/lib/mcp/credentials"
import { defaultMcpRuntimeGateway } from "@/lib/mcp/runtime-gateway"
import { registerSlashCommand, unregisterSlashCommand } from "@/lib/slash-commands/registry"

type Discovery = Pick<McpCapabilityCacheRow, "resources" | "prompts">

interface RegisteredMcpChatSurface {
  pluginId: string
  docsProviderId: string
  commandIds: string[]
}

const registrations = new Map<string, RegisteredMcpChatSurface>()

function commandTokenPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

function providerPrefix(server: McpServer): string {
  const name = commandTokenPart(server.name) || "mcp"
  const suffix = commandTokenPart(server.id).slice(-8)
  return `${name}${suffix ? `-${suffix}` : ""}:`
}

async function resolvedServer(server: McpServer): Promise<McpServer> {
  return { ...server, config: (await resolveMcpSecrets(server.config)) as McpServer["config"] }
}

function textFromPromptContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!content || typeof content !== "object") return JSON.stringify(content)
  const record = content as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return record.text
  if (record.type === "resource" && record.resource && typeof record.resource === "object") {
    const resource = record.resource as Record<string, unknown>
    if (typeof resource.text === "string") return resource.text
  }
  return JSON.stringify(content)
}

function parsePromptArguments(
  raw: string,
  definitions: NonNullable<McpCapabilityCacheRow["prompts"][number]["arguments"]>
): Record<string, string> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MCP prompt arguments must be a JSON object")
    }
    const values = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)])
    )
    const known = new Set(definitions.map((definition) => definition.name))
    const unknown = Object.keys(values).find((key) => !known.has(key))
    if (unknown) throw new Error(`Unknown MCP prompt argument: ${unknown}`)
    return values
  }
  if (definitions.length === 1) return { [definitions[0].name]: trimmed }
  throw new Error("Use a JSON object for MCP prompts with multiple arguments")
}

function validateRequiredPromptArguments(
  values: Record<string, string>,
  definitions: NonNullable<McpCapabilityCacheRow["prompts"][number]["arguments"]>
): void {
  const missing = definitions.find((definition) => definition.required && !values[definition.name])
  if (missing) throw new Error(`Missing required MCP prompt argument: ${missing.name}`)
}

function createResourceProvider(server: McpServer, discovery: Discovery): DocsProvider {
  const resources = new Map(discovery.resources.map((resource) => [resource.uri, resource]))
  const providerId = `mcp:${server.id}`
  return {
    id: providerId,
    mentionPrefix: providerPrefix(server),
    kinds: ["resource"],
    hosts: ["tauri", "web", "headless"],
    async listAccounts() {
      return server.enabled ? [{ id: server.id, label: server.displayName || server.name }] : []
    },
    matchRef(input) {
      const uri = input.trim()
      const resource = resources.get(uri)
      return resource
        ? {
            kind: "resource",
            id: uri,
            url: uri,
            sublabel: resource.description,
          }
        : null
    },
    async search(query, options) {
      const needle = query.trim().toLowerCase()
      return [...resources.values()]
        .filter((resource) =>
          [resource.name, resource.description, resource.uri].some((value) =>
            value?.toLowerCase().includes(needle)
          )
        )
        .slice(0, options.limit)
        .map((resource) => ({
          providerId,
          kind: "resource" as const,
          id: resource.uri,
          title: resource.name || resource.uri,
          url: resource.uri,
          sublabel: resource.description,
        }))
    },
    async fetch(ref, options): Promise<RemoteDocContent> {
      if (options.accountId !== server.id || !resources.has(ref.id)) {
        throw new DocsProviderError("invalidRef")
      }
      const result = await defaultMcpRuntimeGateway.readResource({
        scopeId: `chat-resource:${server.id}`,
        server: await resolvedServer(server),
        uri: ref.id,
        signal: options.signal,
        surface: "chat",
        interactive: true,
      })
      const text = result.contents
        .map((content) => content.text)
        .filter((value): value is string => typeof value === "string")
        .join("\n\n")
      if (!text) throw new DocsProviderError("unsupportedType")
      const resource = resources.get(ref.id)
      return {
        ref,
        title: resource?.name || ref.title || ref.id,
        text,
        format: resource?.mimeType === "text/markdown" ? "markdown" : "text",
      }
    },
  }
}

export function syncManagedMcpChatSurfaces(server: McpServer, discovery: Discovery): void {
  const managed = server.managedBy
  if (!managed) return
  unregisterManagedMcpChatSurfaces(server.id)

  const docsProvider = createResourceProvider(server, discovery)
  if (getDocsProvider(docsProvider.id)) unregisterDocsProvider(docsProvider.id)
  registerDocsProvider(docsProvider)

  const commandIds = discovery.prompts.map((prompt) => {
    const commandId = `external-mcp:${server.id}:${prompt.name}`
    const token = `mcp__${commandTokenPart(server.name) || "server"}__${commandTokenPart(prompt.name) || "prompt"}`
    registerSlashCommand({
      id: commandId,
      name: token,
      description: prompt.description,
      shortcut: prompt.arguments?.map((argument) => argument.name).join(", ") || null,
      source: "plugin",
      pluginId: managed.pluginId,
      category: "plugins",
      async handler(raw, context) {
        const definitions = prompt.arguments ?? []
        const values = parsePromptArguments(raw, definitions)
        validateRequiredPromptArguments(values, definitions)
        const result = await defaultMcpRuntimeGateway.getPrompt({
          scopeId: context?.sessionId || `chat-prompt:${server.id}`,
          server: await resolvedServer(server),
          promptName: prompt.name,
          arguments: values,
          surface: "chat",
          interactive: true,
        })
        const body = result.messages
          .map((message) => `### ${message.role}\n${textFromPromptContent(message.content)}`)
          .join("\n\n")
        return {
          message: `<mcp_prompt server="${server.name}" prompt="${prompt.name}">\n${body}\n</mcp_prompt>`,
        }
      },
    })
    return commandId
  })

  registrations.set(server.id, {
    pluginId: managed.pluginId,
    docsProviderId: docsProvider.id,
    commandIds,
  })
}

export function unregisterManagedMcpChatSurfaces(serverId: string): boolean {
  const registration = registrations.get(serverId)
  if (!registration) return false
  unregisterDocsProvider(registration.docsProviderId)
  registration.commandIds.forEach(unregisterSlashCommand)
  registrations.delete(serverId)
  return true
}

export function unregisterManagedMcpChatSurfacesByPlugin(pluginId: string): number {
  const serverIds = [...registrations.entries()]
    .filter(([, registration]) => registration.pluginId === pluginId)
    .map(([serverId]) => serverId)
  serverIds.forEach(unregisterManagedMcpChatSurfaces)
  return serverIds.length
}

export function __resetManagedMcpChatSurfacesForTesting(): void {
  ;[...registrations.keys()].forEach(unregisterManagedMcpChatSurfaces)
}
