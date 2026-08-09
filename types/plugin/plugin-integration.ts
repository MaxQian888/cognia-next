/**
 * Public contracts for Marketplace-delivered service integrations.
 *
 * Integrations model external SaaS resources, events, and actions. They are
 * intentionally separate from Platform Connectors, whose contract is limited
 * to IM conversation semantics.
 */

export type IntegrationActionRisk = "read" | "write" | "destructive"
export type IntegrationActionIdempotency = "required" | "supported" | "none"
export type IntegrationAuthKind = "oauth2" | "api-key" | "personal-access-token" | "app"

export interface IntegrationAuthStrategy {
  id: string
  type: IntegrationAuthKind
  label: string
  /** Auth provider registered through `ctx.auth`; tokens stay host-owned. */
  providerId: string
  scopes?: string[]
  configSchema?: Record<string, unknown>
  /**
   * Declarative host-side credential injection. The plugin selects the
   * protocol shape, but never receives or writes the credential header.
   */
  requestAuth?: { type: "bearer" } | { type: "header"; name: string; prefix?: string }
}

export interface IntegrationEventTypeDef {
  id: string
  label: string
  description?: string
  resourceKinds: string[]
  payloadSchema?: Record<string, unknown>
}

export interface IntegrationActionDef {
  id: string
  label: string
  description?: string
  /** Named export resolved from the plugin's main module. */
  handler: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  risk: IntegrationActionRisk
  idempotency: IntegrationActionIdempotency
  timeoutMs?: number
}

/**
 * Declarative mapping from a normalized event into one host-owned Inbox
 * conversation. JSON Pointer fields are evaluated against the event payload.
 */
export interface IntegrationInboxProjectionDef {
  id: string
  label: string
  eventTypes: string[]
  threadKeyPointer: string
  titlePointer: string
  bodyPointer: string
  urlPointer?: string
}

export type IntegrationSignatureEncoding = "hex" | "base64"
export type IntegrationSignedPayloadPart =
  { source: "body" } | { source: "header"; name: string } | { source: "literal"; value: string }

export interface IntegrationHmacSha256Verification {
  type: "hmac-sha256"
  signatureHeader: string
  encoding: IntegrationSignatureEncoding
  prefix?: string
  signedPayload?: IntegrationSignedPayloadPart[]
  timestampHeader?: string
  maxSkewSeconds?: number
}

export interface IntegrationStaticTokenVerification {
  type: "static-token"
  tokenHeader: string
}

export type IntegrationIngressVerification =
  IntegrationHmacSha256Verification | IntegrationStaticTokenVerification

export interface PluginIntegrationDef {
  id: string
  label: string
  description?: string
  category?: string
  icon?: string
  authStrategies: IntegrationAuthStrategy[]
  resourceKinds: string[]
  eventTypes: IntegrationEventTypeDef[]
  actions: IntegrationActionDef[]
  /** Optional named export used by the host to discover selectable resources. */
  resourceProvider?: { handler: string; kinds: string[] }
  /** Optional named export used by the host to refresh normalized account health. */
  healthProvider?: { handler: string }
  inboxProjections?: IntegrationInboxProjectionDef[]
  /**
   * Optional webhook contribution. `normalizer` is a named module export that
   * transforms a verified delivery into one or more canonical events.
   */
  ingress?: {
    normalizer: string
    verification: IntegrationIngressVerification
    deliveryIdHeader?: string
    eventTypeHeader?: string
  }
  /** HTTPS origins this integration may target through authenticatedRequest. */
  allowedOrigins?: string[]
}

export interface IntegrationResourceRef {
  kind: string
  id: string
  name?: string
  url?: string
  parent?: { kind: string; id: string }
}

export interface IntegrationResourceQuery {
  accountId: string
  kind: string
  query?: string
  cursor?: string
  limit?: number
}

export interface IntegrationRateLimitStatus {
  remaining?: number
  limit?: number
  resetAt?: string
  retryAt?: string
}

export interface IntegrationResourcePage {
  items: IntegrationResourceRef[]
  nextCursor?: string
  syncedAt: string
  rateLimit?: IntegrationRateLimitStatus
}

export interface IntegrationActor {
  id: string
  label?: string
  avatarUrl?: string
}

export interface IntegrationEventEnvelope<TPayload = Record<string, unknown>> {
  schemaVersion: 1
  id: string
  pluginId: string
  integrationId: string
  accountId: string
  subscriptionId?: string
  deliveryId: string
  eventType: string
  resource?: IntegrationResourceRef
  actor?: IntegrationActor
  occurredAt: string
  receivedAt: string
  payload: TPayload
}

export interface IntegrationVerifiedDelivery {
  routeId: string
  deliveryId: string
  eventType?: string
  headers: Record<string, string>
  body: string
  receivedAt: string
}

export type IntegrationEventNormalizer = (
  delivery: IntegrationVerifiedDelivery,
  context: {
    pluginId: string
    integrationId: string
    accountId: string
    subscriptionId?: string
  }
) =>
  | IntegrationEventEnvelope
  | IntegrationEventEnvelope[]
  | Promise<IntegrationEventEnvelope | IntegrationEventEnvelope[]>

export interface IntegrationRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface IntegrationActionHandlerContext {
  pluginId: string
  integrationId: string
  accountId: string
  jobId: string
  signal: AbortSignal
  authenticatedRequest<T = unknown>(
    input: string,
    init?: IntegrationRequestInit
  ): Promise<{ status: number; headers: Record<string, string>; data: T }>
}

export interface IntegrationProviderContext {
  pluginId: string
  integrationId: string
  accountId: string
  authenticatedRequest<T = unknown>(
    input: string,
    init?: IntegrationRequestInit
  ): Promise<{ status: number; headers: Record<string, string>; data: T }>
}

export type IntegrationResourceProvider = (
  query: IntegrationResourceQuery,
  context: IntegrationProviderContext
) => Promise<IntegrationResourcePage>

export type IntegrationActionHandler = (
  input: Record<string, unknown>,
  context: IntegrationActionHandlerContext
) => Promise<unknown>

export type IntegrationAccountHealth = "unknown" | "healthy" | "degraded" | "revoked"

export type IntegrationRecoveryAction = "reauthorize" | "review-permissions" | "reconnect" | "retry"

export interface IntegrationAccountStatus {
  health: IntegrationAccountHealth
  code?: string
  message?: string
  checkedAt: string
  lastHealthyAt?: string
  lastSyncAt?: string
  recoveryAction?: IntegrationRecoveryAction
  requiredPermissions?: string[]
  grantedPermissions?: string[]
  rateLimit?: IntegrationRateLimitStatus
  deliveryRecovery?: {
    lastCheckedAt: string
    lastDeliveryId?: string
    /** Delivery IDs whose remote redelivery request failed and must be retried. */
    pendingRedeliveryIds?: string[]
  }
}

export interface IntegrationIngressEndpoint {
  id: string
  accountId: string
  routeId: string
  /** Opaque host keyring handle; never the webhook secret itself. */
  secretHandle: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface IntegrationIngressDeadLetter {
  routeId: string
  deliveryId: string
  eventType?: string
  receivedAt: string
  attempts: number
}

export interface IntegrationIngressDeadLetterDetail extends IntegrationIngressDeadLetter {
  headers: Record<string, string>
  body: string
}

export type IntegrationAccountStatusProvider = (
  context: IntegrationProviderContext
) => Promise<IntegrationAccountStatus>

export interface IntegrationAccount {
  id: string
  pluginId: string
  integrationId: string
  providerId: string
  authSessionId: string
  remoteAccountId: string
  /** Host-approved additional origins, used for explicit self-hosted installations. */
  approvedOrigins?: string[]
  label: string
  enabled: boolean
  health: IntegrationAccountHealth
  status?: IntegrationAccountStatus
  /** Explicit user confirmation required before the host changes a remote App webhook. */
  dedicatedAppConfirmed?: boolean
  /** Account-level webhook endpoint. Deprecated subscription fields remain for v2 migration. */
  ingressEndpoint?: IntegrationIngressEndpoint
  createdAt: string
  updatedAt: string
}

export interface IntegrationAccountInput {
  integrationId: string
  providerId: string
  authSessionId: string
  remoteAccountId: string
  approvedOrigins?: string[]
  label: string
  enabled?: boolean
  dedicatedAppConfirmed?: boolean
}

export interface IntegrationSubscription {
  id: string
  pluginId: string
  integrationId: string
  accountId: string
  resourceKind?: string
  resourceId?: string
  eventTypes: string[]
  inboxProjectionId?: string
  ingressRouteId?: string
  /** Opaque host keyring handle; never the webhook secret itself. */
  ingressSecretHandle?: string
  enabled: boolean
  /** True when access was removed remotely; preserves the user's configuration for recovery. */
  disabledByProvider?: boolean
  disabledReason?: string
  createdAt: string
  updatedAt: string
}

export interface IntegrationSubscriptionInput {
  integrationId: string
  accountId: string
  resourceKind?: string
  resourceId?: string
  eventTypes: string[]
  inboxProjectionId?: string
  ingressSecretHandle?: string
  enabled?: boolean
}

export type IntegrationActionJobStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "retry_wait"
  | "failed"
  | "deadlettered"
  | "cancelled"

export interface IntegrationActionJob {
  id: string
  pluginId: string
  integrationId: string
  accountId: string
  actionId: string
  input: Record<string, unknown>
  status: IntegrationActionJobStatus
  risk: IntegrationActionRisk
  idempotencyKey?: string
  attempts: number
  maxAttempts: number
  nextAttemptAt?: string
  output?: unknown
  error?: string
  source: "manual" | "workflow" | "inbox"
  createdAt: string
  updatedAt: string
}

export interface ExecuteIntegrationActionInput {
  integrationId: string
  accountId: string
  actionId: string
  input: Record<string, unknown>
  idempotencyKey?: string
  source?: IntegrationActionJob["source"]
}

export interface IntegrationAuditEntry {
  id: string
  pluginId: string
  integrationId: string
  accountId?: string
  kind: string
  outcome: "allowed" | "denied" | "succeeded" | "failed"
  detail?: Record<string, unknown>
  createdAt: string
}

export interface IntegrationMigrationPlan {
  id: string
  integrationId: string
  accounts: Array<IntegrationAccountInput & { id: string }>
  subscriptions: Array<IntegrationSubscriptionInput & { id: string }>
  workflowKindAliases: Record<string, string>
}

export interface IntegrationMigrationResult {
  migrationId: string
  migratedAccounts: number
  migratedSubscriptions: number
  migratedWorkflows: number
  alreadyApplied: boolean
}

export interface PluginIntegrationsAPI {
  listDefinitions(): PluginIntegrationDef[]
  listAccounts(integrationId?: string): Promise<IntegrationAccount[]>
  createAccount(input: IntegrationAccountInput): Promise<IntegrationAccount>
  updateAccount(
    accountId: string,
    patch: Partial<Pick<IntegrationAccount, "label" | "enabled">>
  ): Promise<IntegrationAccount>
  removeAccount(accountId: string): Promise<void>
  listSubscriptions(accountId?: string): Promise<IntegrationSubscription[]>
  listResources(query: IntegrationResourceQuery): Promise<IntegrationResourcePage>
  checkAccountHealth(accountId: string): Promise<IntegrationAccountStatus>
  createSubscription(input: IntegrationSubscriptionInput): Promise<IntegrationSubscription>
  removeSubscription(subscriptionId: string): Promise<void>
  publishEvent(event: IntegrationEventEnvelope): Promise<{ inserted: boolean }>
  executeAction(input: ExecuteIntegrationActionInput): Promise<IntegrationActionJob>
  getActionJob(jobId: string): Promise<IntegrationActionJob | undefined>
  cancelAction(jobId: string): Promise<IntegrationActionJob>
  authenticatedRequest<T = unknown>(
    accountId: string,
    input: string,
    init?: IntegrationRequestInit
  ): Promise<{ status: number; headers: Record<string, string>; data: T }>
  getIngressPublicUrl(subscriptionId: string): Promise<string | undefined>
  listIngressDeadletters(accountId: string): Promise<IntegrationIngressDeadLetter[]>
  getIngressDeadletter(
    accountId: string,
    routeId: string,
    deliveryId: string
  ): Promise<IntegrationIngressDeadLetterDetail | undefined>
  requeueIngressDeadletter(accountId: string, routeId: string, deliveryId: string): Promise<boolean>
  migrateLegacy(plan: IntegrationMigrationPlan): Promise<IntegrationMigrationResult>
  rollbackMigration(migrationId: string): Promise<void>
}
