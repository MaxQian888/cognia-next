/**
 * CLIProxyAPI Provider Integration
 * Self-hosted AI proxy aggregating multiple providers
 * https://help.router-for.me
 */

export interface CLIProxyAPIConfig {
  host: string
  port: number
  apiKey: string
  managementKey?: string
}

export interface CLIProxyAPIModel {
  id: string
  name: string
  provider?: string
  contextLength?: number
}

export interface CLIProxyAPIServerInfo {
  version?: string
  uptime?: number
  models: CLIProxyAPIModel[]
}

export interface CLIProxyAPIUsageStats {
  totalRequests: number
  totalTokens: number
  byModel: Record<string, { requests: number; tokens: number }>
}

export class CLIProxyAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message)
    this.name = "CLIProxyAPIError"
  }
}

/**
 * Get the base URL for CLIProxyAPI
 */
export function getBaseURL(host: string = "localhost", port: number = 8317): string {
  return `http://${host}:${port}`
}

/**
 * Get the API URL for CLIProxyAPI
 */
export function getAPIURL(host: string = "localhost", port: number = 8317): string {
  return `${getBaseURL(host, port)}/v1`
}

/**
 * Get the WebUI URL for CLIProxyAPI
 */
export function getWebUIURL(host: string = "localhost", port: number = 8317): string {
  return `${getBaseURL(host, port)}/management.html`
}

/**
 * Test connection to CLIProxyAPI server
 */
export async function testConnection(
  apiKey: string,
  host: string = "localhost",
  port: number = 8317
): Promise<{ success: boolean; message: string; latency?: number }> {
  const startTime = Date.now()

  try {
    const response = await fetch(`${getAPIURL(host, port)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    })

    const latency = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        message: `Server returned ${response.status}: ${errorText}`,
        latency,
      }
    }

    return {
      success: true,
      message: "Connected to CLIProxyAPI server",
      latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * Fetch available models from CLIProxyAPI server
 */
export async function fetchModels(
  apiKey: string,
  host: string = "localhost",
  port: number = 8317
): Promise<CLIProxyAPIModel[]> {
  try {
    const response = await fetch(`${getAPIURL(host, port)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      throw new CLIProxyAPIError(`Failed to fetch models: ${response.statusText}`, response.status)
    }

    const data = await response.json()

    // OpenAI-compatible response format
    if (data.data && Array.isArray(data.data)) {
      return data.data.map((model: { id: string; object?: string; owned_by?: string }) => ({
        id: model.id,
        name: model.id,
        provider: model.owned_by,
      }))
    }

    return []
  } catch (error) {
    if (error instanceof CLIProxyAPIError) {
      throw error
    }
    throw new CLIProxyAPIError(error instanceof Error ? error.message : "Failed to fetch models")
  }
}

/**
 * Fetch server health status
 */
export async function fetchHealthStatus(
  host: string = "localhost",
  port: number = 8317
): Promise<{ healthy: boolean; message: string }> {
  try {
    const response = await fetch(`${getBaseURL(host, port)}/health`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    })

    if (response.ok) {
      return { healthy: true, message: "Server is healthy" }
    }

    return { healthy: false, message: `Server returned ${response.status}` }
  } catch (error) {
    return {
      healthy: false,
      message: error instanceof Error ? error.message : "Health check failed",
    }
  }
}

/**
 * Fetch usage statistics (requires management key)
 */
export async function fetchUsageStats(
  managementKey: string,
  host: string = "localhost",
  port: number = 8317
): Promise<CLIProxyAPIUsageStats | null> {
  try {
    const response = await fetch(`${getBaseURL(host, port)}/v0/management/stats`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      return null
    }

    return await response.json()
  } catch {
    return null
  }
}

/**
 * Check if WebUI is accessible
 */
export async function checkWebUIAccess(
  host: string = "localhost",
  port: number = 8317
): Promise<boolean> {
  try {
    const response = await fetch(`${getWebUIURL(host, port)}`, {
      method: "HEAD",
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Format API key for display (mask middle portion)
 * Named differently from openrouter.ts to avoid export conflict
 */
export function maskCLIProxyApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return "****"
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
}

/**
 * Parse model ID to extract provider prefix if present
 * CLIProxyAPI supports format: "prefix/model-name"
 */
export function parseCLIProxyModelId(modelId: string): { prefix?: string; model: string } {
  const slashIndex = modelId.indexOf("/")
  if (slashIndex > 0) {
    return {
      prefix: modelId.slice(0, slashIndex),
      model: modelId.slice(slashIndex + 1),
    }
  }
  return { model: modelId }
}

/**
 * Build model ID with optional prefix
 */
export function buildModelId(model: string, prefix?: string): string {
  if (prefix) {
    return `${prefix}/${model}`
  }
  return model
}

/**
 * Default CLIProxyAPI configuration
 */
export const DEFAULT_CONFIG: CLIProxyAPIConfig = {
  host: "localhost",
  port: 8317,
  apiKey: "",
}

/**
 * Common model aliases used in CLIProxyAPI
 */
export const COMMON_MODEL_ALIASES: Record<string, string> = {
  "gemini-flash": "gemini-2.5-flash",
  "gemini-pro": "gemini-2.5-pro",
  "claude-sonnet": "claude-sonnet-4-20250514",
  "claude-opus": "claude-opus-4-20250514",
  gpt4o: "gpt-4o",
  deepseek: "deepseek-v4-flash",
}
