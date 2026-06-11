import { invoke } from "@tauri-apps/api/core"

export type PluginApiErrorCode =
  | "INVALID_REQUEST"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "NOT_SUPPORTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT"
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

export interface InvokePluginApiOptions {
  timeoutMs?: number
  context?: unknown
  sdkVersion?: string
  retries?: number
  retryDelayMs?: number
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
  const retries = options.retries ?? 1
  const retryDelayMs = options.retryDelayMs ?? 150
  const request: PluginApiInvokeRequest = {
    sdkVersion: options.sdkVersion ?? "2.0.0",
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
    const response = await invoke<PluginApiInvokeResponse<T>>("plugin_api_invoke", {
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
    sdkVersion: options?.sdkVersion ?? "2.0.0",
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

  const response = await invoke<{
    success: boolean
    results: PluginApiInvokeResponse[]
  }>("plugin_api_batch_invoke", { request: payload })

  return response.results
}

export async function getPluginCapabilities() {
  return invoke<
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
  await invoke("plugin_permission_grant", {
    pluginId,
    permission,
    grantedBy,
    expiresAt: expiresAt ?? null,
  })
}

export async function revokePluginPermission(pluginId: string, permission: string): Promise<void> {
  await invoke("plugin_permission_revoke", { pluginId, permission })
}

export async function listPluginPermissions(pluginId: string): Promise<string[]> {
  return invoke<string[]>("plugin_permission_list", { pluginId })
}
