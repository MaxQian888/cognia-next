import { isTauri } from "@/lib/native/utils"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import {
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_GATEWAY_CLIENT_VERSION,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_SDK_VERSION,
} from "@/packages/plugin-sdk/src/contracts/generated"

async function invokePluginHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Always use the shared transport: it resolves to Tauri locally and to the
  // active Companion route for a separated remote UI. Direct `invoke` here
  // would mutate the viewer's local permission ledger instead of the brain's.
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call<T>(command, args)
}

/** True when the canonical Rust plugin gateway is reachable on this host. */
export function isPluginGatewayAvailable(): boolean {
  return isTauri() || isHeadlessHost() || isRemoteHostActive()
}

export type PluginApiErrorCode =
  | "INVALID_REQUEST"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "NOT_SUPPORTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT"
  | "INCOMPATIBLE_SDK"
  | "INTERNAL"

export interface PluginApiError {
  code: PluginApiErrorCode
  message: string
  details?: unknown
}

export interface PluginApiCompat {
  sdkVersion: string
  minSupportedSdk: string
  compatible: boolean
}

export interface PluginApiInvokeRequest {
  sdkVersion: string
  pluginId: string
  requestId: string
  api: string
  payload: unknown
  timeoutMs?: number
  context?: unknown
}

export interface PluginApiInvokeResponse<T = unknown> {
  requestId: string
  success: boolean
  data?: T
  error?: PluginApiError
  runtimeVersion: string
  compat: PluginApiCompat
}

export interface PluginRuntimeHandshake {
  sdk_version: string
  protocol_version: string
  contract_version: string
  runtime_id: string
  capabilities: string[]
  legacy_adapter: boolean
}

export function normalizePluginRuntimeHandshake<T extends Record<string, unknown>>(
  info: T,
  runtimeId: string
): T & PluginRuntimeHandshake {
  const hasHandshake =
    typeof info.sdk_version === "string" &&
    typeof info.protocol_version === "string" &&
    typeof info.contract_version === "string"
  return {
    ...info,
    sdk_version: hasHandshake ? info.sdk_version : PLUGIN_SDK_VERSION,
    protocol_version: hasHandshake ? info.protocol_version : PLUGIN_PROTOCOL_VERSION,
    contract_version: hasHandshake ? info.contract_version : PLUGIN_CONTRACT_VERSION,
    runtime_id: typeof info.runtime_id === "string" ? info.runtime_id : runtimeId,
    capabilities: Array.isArray(info.capabilities)
      ? info.capabilities.filter((value): value is string => typeof value === "string")
      : [],
    legacy_adapter: hasHandshake ? info.legacy_adapter === true : true,
  } as T & PluginRuntimeHandshake
}

export interface InvokePluginApiOptions {
  timeoutMs?: number
  context?: unknown
  sdkVersion?: string
  /**
   * Retry attempts after the first failure. Defaults to 1 for idempotent
   * (read-shaped) APIs and 0 otherwise (W6.3) — a TIMEOUT on a
   * side-effecting call may have executed host-side, so blind retry could
   * double-execute. Pass explicitly to override either way.
   */
  retries?: number
  retryDelayMs?: number
  /** Force the idempotency classification instead of deriving it from `api`. */
  idempotent?: boolean
}

export class PluginGatewayError extends Error {
  readonly code: PluginApiErrorCode
  readonly details?: unknown
  readonly requestId: string
  readonly api: string
  readonly pluginId: string

  constructor(input: {
    code: PluginApiErrorCode
    message: string
    details?: unknown
    requestId: string
    api: string
    pluginId: string
  }) {
    super(input.message)
    this.name = "PluginGatewayError"
    this.code = input.code
    this.details = input.details
    this.requestId = input.requestId
    this.api = input.api
    this.pluginId = input.pluginId
  }
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function shouldRetry(code: PluginApiErrorCode): boolean {
  return code === "TIMEOUT" || code === "INTERNAL"
}

/**
 * Read-shaped APIs are safe to retry; anything else (set/write/delete/run/…)
 * may have executed host-side before the failure surfaced (W6.3).
 */
const IDEMPOTENT_API_PATTERN =
  /:(get|list|read|stat|exists|has|describe|query|watch|status|info|count|peek)([:.]|$)/

export function isIdempotentPluginApi(api: string): boolean {
  return IDEMPOTENT_API_PATTERN.test(api)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function invokePluginApi<T = unknown>(
  pluginId: string,
  api: string,
  payload: unknown,
  options: InvokePluginApiOptions = {}
): Promise<T> {
  const requestId = createRequestId()
  const idempotent = options.idempotent ?? isIdempotentPluginApi(api)
  const retries = options.retries ?? (idempotent ? 1 : 0)
  const retryDelayMs = options.retryDelayMs ?? 150
  const request: PluginApiInvokeRequest = {
    sdkVersion: options.sdkVersion ?? PLUGIN_GATEWAY_CLIENT_VERSION,
    pluginId,
    requestId,
    api,
    payload,
    timeoutMs: options.timeoutMs,
    context: options.context,
  }

  let attempt = 0
  while (true) {
    attempt += 1
    const response = await invokePluginHost<PluginApiInvokeResponse<T>>("plugin_api_invoke", {
      request,
    })

    if (response.success) {
      return response.data as T
    }

    const error = response.error ?? {
      code: "INTERNAL",
      message: "Unknown plugin gateway error",
    }
    if (attempt <= retries && shouldRetry(error.code)) {
      await sleep(retryDelayMs * attempt)
      continue
    }

    throw new PluginGatewayError({
      code: error.code,
      message: error.message,
      details: error.details,
      requestId,
      api,
      pluginId,
    })
  }
}

export async function invokePluginApiBatch(
  pluginId: string,
  requests: Array<{
    api: string
    payload: unknown
    timeoutMs?: number
    context?: unknown
  }>,
  options?: {
    strategy?: "continueOnError" | "abortOnError"
    sdkVersion?: string
  }
): Promise<PluginApiInvokeResponse[]> {
  const payload = {
    sdkVersion: options?.sdkVersion ?? PLUGIN_GATEWAY_CLIENT_VERSION,
    pluginId,
    strategy: options?.strategy ?? "continueOnError",
    requests: requests.map((item) => ({
      requestId: createRequestId(),
      api: item.api,
      payload: item.payload,
      timeoutMs: item.timeoutMs,
      context: item.context,
    })),
  }

  const response = await invokePluginHost<{
    success: boolean
    results: PluginApiInvokeResponse[]
  }>("plugin_api_batch_invoke", { request: payload })

  return response.results
}

export async function getPluginCapabilities() {
  return invokePluginHost<
    Array<{
      api: string
      supported: boolean
      highRisk: boolean
      requiredPermissions: string[]
      platform?: string
    }>
  >("plugin_get_capabilities")
}

export async function grantPluginPermission(
  pluginId: string,
  permission: string,
  grantedBy = "user",
  expiresAt?: string
): Promise<void> {
  // Flat args matching the Rust command signature
  // `plugin_permission_grant(plugin_id, permission, granted_by, expires_at)`.
  // The old `{ request: { … } }` wrapper never deserialized, so grants
  // silently failed to persist. Tauri maps camelCase JS keys to snake_case.
  await invokePluginHost("plugin_permission_grant", {
    pluginId,
    permission,
    grantedBy,
    expiresAt: expiresAt ?? null,
  })
}

export async function revokePluginPermission(pluginId: string, permission: string): Promise<void> {
  await invokePluginHost("plugin_permission_revoke", { pluginId, permission })
}

export async function listPluginPermissions(pluginId: string): Promise<string[]> {
  const grants = await invokePluginHost<Array<string | { permission?: unknown }>>(
    "plugin_permission_list",
    { pluginId }
  )
  return grants.flatMap((grant) => {
    if (typeof grant === "string") return [grant]
    return typeof grant?.permission === "string" ? [grant.permission] : []
  })
}
