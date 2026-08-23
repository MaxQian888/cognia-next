import { resolvePublishedWorkflowApp } from "@/lib/db/workflow-apps"
import { authenticateWorkflowAppApiKey, WorkflowAppKeyError } from "./api-key-service"
import { executePublishedWorkflowApp } from "./app-execution"

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export class WorkflowAppMcpError extends Error {
  constructor(
    readonly code: "app_not_found" | "mcp_disabled" | "mcp_token_revoked",
    message: string
  ) {
    super(message)
    this.name = "WorkflowAppMcpError"
  }
}

function response(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result }
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

function requestId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null
}

function toolName(slug: string): string {
  return `run_${slug.replaceAll("-", "_")}`
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? null)
}

export async function handleWorkflowAppMcpRequest(input: {
  apiKey: string
  appSlug: string
  request: unknown
}): Promise<unknown> {
  const authenticated = await authenticateWorkflowAppApiKey(input.apiKey, "mcp:invoke")
  if (authenticated.appSlug !== input.appSlug) {
    throw new WorkflowAppMcpError("app_not_found", "Published MCP application was not found")
  }
  const resolved = await resolvePublishedWorkflowApp(authenticated.accountId, input.appSlug)
  if (!resolved || resolved.app.id !== authenticated.appId) {
    throw new WorkflowAppMcpError("app_not_found", "Published MCP application was not found")
  }
  if (!resolved.release.snapshot.mcp.enabled) {
    throw new WorkflowAppMcpError("mcp_disabled", "MCP is disabled for this application release")
  }
  const tokenVersion = resolved.release.snapshot.mcp.tokenVersion ?? 1
  if (authenticated.key.mcpTokenVersion !== tokenVersion) {
    throw new WorkflowAppMcpError(
      "mcp_token_revoked",
      "The MCP application key was revoked by a token rotation"
    )
  }

  if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) {
    return error(null, -32600, "Invalid Request")
  }
  const request = input.request as JsonRpcRequest
  const id = requestId(request.id)
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return error(id, -32600, "Invalid Request")
  }
  if (request.method === "notifications/initialized") return null
  if (request.method === "initialize") {
    return response(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `Cognia Workflow App: ${resolved.app.slug}`, version: "1.0.0" },
    })
  }
  const name = toolName(resolved.app.slug)
  if (request.method === "tools/list") {
    return response(id, {
      tools: [
        {
          name,
          title:
            resolved.release.snapshot.localized.en?.title ??
            resolved.release.snapshot.localized["zh-CN"]?.title ??
            resolved.app.slug,
          description:
            resolved.release.snapshot.localized.en?.description ??
            resolved.release.snapshot.localized["zh-CN"]?.description ??
            `Run the ${resolved.app.slug} workflow application`,
          inputSchema: resolved.release.workflowInterface.inputSchema ?? {
            type: "object",
            additionalProperties: true,
          },
          ...(resolved.release.workflowInterface.outputSchema
            ? { outputSchema: resolved.release.workflowInterface.outputSchema }
            : {}),
        },
      ],
    })
  }
  if (request.method === "tools/call") {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : undefined
    if (!params || params.name !== name) return error(id, -32602, "Unknown application tool")
    const execution = await executePublishedWorkflowApp({
      resolved,
      actor: {
        authenticated: false,
        externalSubjectKey: `api-key:${authenticated.key.id}`,
        serviceCredentialId: authenticated.key.id,
      },
      input: params.arguments ?? {},
      idempotencyKey: `mcp:${authenticated.key.id}:${String(id)}`,
      entrypoint: "mcp",
    })
    const output = execution.result.output
    return response(id, {
      content: [{ type: "text", text: text(output ?? execution.result.error?.message) }],
      ...(output === undefined ? {} : { structuredContent: output }),
      isError: execution.result.status !== "succeeded",
    })
  }
  return error(id, -32601, "Method not found")
}

export { WorkflowAppKeyError }
