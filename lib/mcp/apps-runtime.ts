import type { McpCapabilityCacheRow, McpServer, McpToolRisk } from "@cognia/agent-config-types"
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge"

import { getDb } from "@/lib/db/schema"
import { getMcpServer, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { matchesToolPattern } from "./tool-rules"
import { defaultMcpRuntimeGateway } from "./runtime-gateway"
import { resolveMcpRuntimeCredential } from "./credential-resolver"
import { invokeMcpTool } from "./invoke"
import { saveBinaryFileAs, saveFileAs } from "@/lib/files/file-bridge"

export interface LoadedMcpApp {
  server: McpServer
  toolName: string
  resourceUri: string
  html: string
  csp?: McpUiResourceCsp
  permissions?: McpUiResourcePermissions
  risk: McpToolRisk
}

interface AppDownloadDeps {
  readLinked?: typeof readMcpDownloadResource
  saveText?: typeof saveFileAs
  saveBinary?: typeof saveBinaryFileAs
}

interface AppsRuntimeDeps {
  listServers?: typeof listEnabledMcpServers
  loadCapabilities?: (serverId: string) => Promise<McpCapabilityCacheRow[]>
  readResource?: typeof readMcpAppResource
}

export function parseNamespacedMcpToolName(
  value: string
): { namespace: string; toolName: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(value)
  if (!match?.[1] || !match[2]) return undefined
  return { namespace: match[1], toolName: match[2] }
}

export async function loadMcpAppForTool(
  namespacedToolName: string,
  scopeId: string,
  deps: AppsRuntimeDeps = {}
): Promise<LoadedMcpApp | undefined> {
  const parsed = parseNamespacedMcpToolName(namespacedToolName)
  if (!parsed) return undefined
  const servers = await (deps.listServers ?? listEnabledMcpServers)()
  const server = servers.find((candidate) => candidate.name === parsed.namespace)
  if (!server) return undefined
  const rows = await (deps.loadCapabilities ?? loadCapabilities)(server.id)
  if (rows.length === 0) return undefined
  const freshest = rows.reduce((best, row) => (row.updatedAt > best.updatedAt ? row : best))
  const tool = freshest.tools.find((candidate) => candidate.name === parsed.toolName)
  const resourceUri = tool ? toolUiResourceUri(tool._meta) : undefined
  if (!resourceUri) return undefined
  const resource = await (deps.readResource ?? readMcpAppResource)(server, resourceUri, scopeId)
  return {
    server,
    toolName: parsed.toolName,
    resourceUri,
    html: resource.html,
    csp: resource.csp,
    permissions: resource.permissions,
    risk: getMcpAppToolRisk(server, parsed.toolName),
  }
}

export function getMcpAppToolRisk(server: McpServer, toolName: string): McpToolRisk {
  return (
    server.toolRiskRules?.find((candidate) => matchesToolPattern(toolName, candidate.pattern))
      ?.risk ?? "write"
  )
}

/** Promote an already user-confirmed in-memory quarantine batch through native save dialogs. */
export async function promoteMcpAppDownload(
  server: McpServer,
  scopeId: string,
  contents: unknown[],
  deps: AppDownloadDeps = {}
): Promise<number> {
  let saved = 0
  for (const item of contents) {
    const resolved = await resolveDownloadResource(server, scopeId, item, deps)
    if (!resolved) continue
    const ok =
      resolved.text !== undefined
        ? await (deps.saveText ?? saveFileAs)({
            defaultName: resolved.filename,
            content: resolved.text,
          })
        : await (deps.saveBinary ?? saveBinaryFileAs)({
            defaultName: resolved.filename,
            bytes: resolved.bytes ?? new Uint8Array(),
            mimeType: resolved.mimeType,
          })
    if (ok) saved += 1
  }
  return saved
}

export async function readMcpAppResource(
  server: McpServer,
  resourceUri: string,
  scopeId: string
): Promise<{
  html: string
  csp?: McpUiResourceCsp
  permissions?: McpUiResourcePermissions
}> {
  const resource = await readMcpDownloadResource(server, resourceUri, scopeId)
  if (resource.mimeType !== "text/html;profile=mcp-app" || !resource.text) {
    throw new Error("MCP App resource must return text/html;profile=mcp-app HTML")
  }
  const meta = resource._meta?.ui
  const ui = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined
  return {
    html: resource.text,
    csp: isRecord(ui?.csp) ? (ui.csp as McpUiResourceCsp) : undefined,
    permissions: isRecord(ui?.permissions)
      ? (ui.permissions as McpUiResourcePermissions)
      : undefined,
  }
}

export async function readMcpDownloadResource(
  server: McpServer,
  resourceUri: string,
  scopeId: string
): Promise<{
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  _meta?: Record<string, unknown>
}> {
  const resolved = await resolveMcpRuntimeCredential(server)
  const result = await defaultMcpRuntimeGateway.readResource({
    scopeId,
    server: resolved.server,
    uri: resourceUri,
    surface: "chat",
    interactive: true,
    refreshAuth: resolved.refreshAuth,
  })
  const resource = result.contents.find((candidate) => candidate.uri === resourceUri)
  if (!resource) throw new Error(`MCP resource ${resourceUri} was not returned`)
  return resource
}

export async function callMcpAppTool(input: {
  serverId: string
  toolName: string
  args?: Record<string, unknown>
  scopeId: string
}) {
  const server = await getMcpServer(input.serverId)
  if (!server) throw new Error(`MCP server ${input.serverId} not found`)
  return invokeMcpTool(
    {
      serverId: input.serverId,
      toolName: input.toolName,
      args: input.args,
      scopeId: input.scopeId,
      surface: "chat",
      interactive: true,
    },
    { getServer: async () => server }
  )
}

async function loadCapabilities(serverId: string): Promise<McpCapabilityCacheRow[]> {
  return getDb().mcpCapabilityCache.where("serverId").equals(serverId).toArray()
}

function toolUiResourceUri(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined
  const ui = isRecord(meta.ui) ? meta.ui : undefined
  const candidate = ui?.resourceUri ?? meta["ui/resourceUri"]
  return typeof candidate === "string" && candidate.startsWith("ui://") ? candidate : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function resolveDownloadResource(
  server: McpServer,
  scopeId: string,
  value: unknown,
  deps: AppDownloadDeps
): Promise<{ filename: string; mimeType?: string; text?: string; bytes?: Uint8Array } | undefined> {
  if (!isRecord(value)) return undefined
  if (value.type === "resource_link" && typeof value.uri === "string") {
    const linked = await (deps.readLinked ?? readMcpDownloadResource)(server, value.uri, scopeId)
    if (linked.text !== undefined) {
      return { filename: filenameFromUri(value.uri), text: linked.text, mimeType: linked.mimeType }
    }
    if (linked.blob !== undefined) {
      return {
        filename: filenameFromUri(value.uri),
        bytes: decodeBase64(linked.blob),
        mimeType: linked.mimeType,
      }
    }
    return undefined
  }
  if (value.type !== "resource" || !isRecord(value.resource)) return undefined
  const resource = value.resource
  const uri = typeof resource.uri === "string" ? resource.uri : "mcp-app-download"
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined
  if (typeof resource.text === "string") {
    return { filename: filenameFromUri(uri), text: resource.text, mimeType }
  }
  if (typeof resource.blob === "string") {
    return {
      filename: filenameFromUri(uri),
      bytes: decodeBase64(resource.blob),
      mimeType,
    }
  }
  return undefined
}

function filenameFromUri(uri: string): string {
  try {
    const parsed = new URL(uri)
    return decodeURIComponent(
      parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname ?? "download"
    )
  } catch {
    return "download"
  }
}

function decodeBase64(value: string): Uint8Array {
  const encoded = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
