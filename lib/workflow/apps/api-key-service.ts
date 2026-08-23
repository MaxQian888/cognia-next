import { getDb } from "@/lib/db/schema"
import type { WorkflowAppApiKey, WorkflowAppApiKeyScope } from "@/types/workflow/api-key"

export class WorkflowAppKeyError extends Error {
  constructor(
    readonly code:
      "invalid_key" | "scope_denied" | "app_not_found" | "invalid_expiry" | "mcp_disabled",
    message: string
  ) {
    super(message)
    this.name = "WorkflowAppKeyError"
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function createWorkflowAppApiKey(input: {
  accountId: string
  appId: string
  name: string
  scopes: WorkflowAppApiKeyScope[]
  expiresAt?: number
  now?: number
}): Promise<{ key: WorkflowAppApiKey; secret: string }> {
  const app = await getDb().workflowApps.get(input.appId)
  if (!app || app.accountId !== input.accountId) {
    throw new WorkflowAppKeyError("app_not_found", "Workflow app was not found")
  }
  const now = input.now ?? Date.now()
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    throw new WorkflowAppKeyError("invalid_expiry", "Application key expiry must be in the future")
  }
  const random = crypto.getRandomValues(new Uint8Array(32))
  const secret = `cog_app_${base64Url(random)}`
  let mcpTokenVersion: number | undefined
  if (input.scopes.includes("mcp:invoke")) {
    const release = app.currentReleaseId
      ? await getDb().workflowAppReleases.get(app.currentReleaseId)
      : undefined
    if (!release?.snapshot.mcp.enabled) {
      throw new WorkflowAppKeyError(
        "mcp_disabled",
        "Publish the application with MCP enabled before creating an MCP key"
      )
    }
    mcpTokenVersion = release.snapshot.mcp.tokenVersion ?? 1
  }
  const key: WorkflowAppApiKey = {
    id: `wfak_${crypto.randomUUID()}`,
    accountId: input.accountId,
    appId: input.appId,
    name: input.name.trim() || "Application key",
    prefix: secret.slice(0, 16),
    secretHash: await hashSecret(secret),
    scopes: [...new Set(input.scopes)],
    createdAt: now,
    updatedAt: now,
    ...(mcpTokenVersion !== undefined ? { mcpTokenVersion } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }
  await getDb().workflowAppApiKeys.add(key)
  return { key, secret }
}

export async function authenticateWorkflowAppApiKey(
  secret: string,
  requiredScope: WorkflowAppApiKeyScope,
  now = Date.now()
): Promise<{ key: WorkflowAppApiKey; accountId: string; appId: string; appSlug: string }> {
  if (!secret.startsWith("cog_app_") || secret.length > 256) {
    throw new WorkflowAppKeyError("invalid_key", "Application key is invalid")
  }
  const hash = await hashSecret(secret)
  const key = await getDb().workflowAppApiKeys.where("secretHash").equals(hash).first()
  if (
    !key ||
    key.revokedAt !== undefined ||
    (key.expiresAt !== undefined && key.expiresAt <= now)
  ) {
    throw new WorkflowAppKeyError("invalid_key", "Application key is invalid or expired")
  }
  if (!key.scopes.includes(requiredScope)) {
    throw new WorkflowAppKeyError("scope_denied", `Application key lacks ${requiredScope}`)
  }
  const app = await getDb().workflowApps.get(key.appId)
  if (!app || app.accountId !== key.accountId || !app.currentReleaseId) {
    throw new WorkflowAppKeyError("app_not_found", "Published application was not found")
  }
  await getDb().workflowAppApiKeys.update(key.id, { lastUsedAt: now, updatedAt: now })
  return {
    key: { ...key, lastUsedAt: now, updatedAt: now },
    accountId: key.accountId,
    appId: app.id,
    appSlug: app.slug,
  }
}

export async function revokeWorkflowAppApiKey(input: {
  accountId: string
  keyId: string
  now?: number
}): Promise<void> {
  const key = await getDb().workflowAppApiKeys.get(input.keyId)
  if (!key || key.accountId !== input.accountId) {
    throw new WorkflowAppKeyError("invalid_key", "Application key was not found")
  }
  const now = input.now ?? Date.now()
  await getDb().workflowAppApiKeys.update(key.id, { revokedAt: now, updatedAt: now })
}
