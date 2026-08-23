export type WorkflowAppApiKeyScope =
  | "workflow:run"
  | "chat:write"
  | "conversation:read"
  | "conversation:write"
  | "feedback:write"
  | "file:write"
  | "mcp:invoke"

export interface WorkflowAppApiKey {
  id: string
  accountId: string
  appId: string
  name: string
  prefix: string
  secretHash: string
  scopes: WorkflowAppApiKeyScope[]
  createdAt: number
  updatedAt: number
  expiresAt?: number
  revokedAt?: number
  lastUsedAt?: number
  /** MCP endpoint revocation epoch captured when the key is created. */
  mcpTokenVersion?: number
}
