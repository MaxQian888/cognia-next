import {
  LocalProviderName,
  LocalServerStatus,
  LocalModelInfo,
  LocalModelPullProgress,
} from "@cognia/provider-types/local-provider"
import { LocalProviderConfig } from "./local-providers.js"
import "@cognia/provider-types"

/**
 * Local Provider Service - Unified abstraction for all local inference engines
 *
 * Provides common patterns for:
 * - Connection testing and health checks
 * - Model listing and management
 * - Installation detection
 * - Configuration management
 *
 * Every request goes through `proxyFetch`, never a bare `fetch`. In the
 * packaged desktop shell the renderer's CSP (`connect-src 'self' ipc:
 * http://ipc.localhost ws: wss:`) carries no `http:` scheme, so a direct
 * `fetch` to a local inference server on `127.0.0.1` is blocked before it
 * leaves the WebView — loopback is not `'self'`. `proxyFetch` tunnels through
 * the Rust `proxy_http_request` command, which reqwest serves free of CSP and
 * CORS. `pnpm dev` has no CSP, which is why this surface looked healthy in
 * development while being dead in the shipped app.
 *
 * The `invoke("ollama_*")` / `invoke("local_provider_*")` branches that used to
 * front these calls are gone: no such Rust command has ever existed. They were
 * wrapped in `try/catch`, so instead of failing loudly they fell through to the
 * HTTP path on every single desktop run — which the CSP then blocked. Two dead
 * layers stacked into one silent failure.
 */

/**
 * Local provider capabilities
 */
interface LocalProviderCapabilities {
  canListModels: boolean
  canPullModels: boolean
  canDeleteModels: boolean
  canStopModels: boolean
  canGenerateEmbeddings: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsTools: boolean
}
/**
 * Provider installation info
 */
interface LocalProviderInstallInfo {
  installed: boolean
  version?: string
  installPath?: string
  configPath?: string
  dataPath?: string
  executable?: string
}
/**
 * Installation check result.
 *
 * These come from an HTTP probe, which is strictly weaker than an installation
 * check. A responding server proves the provider is both installed and running.
 * SILENCE PROVES NOTHING: "not installed", "installed but not started" and
 * "started on a different port" are indistinguishable from the outside. So
 * `installed` is deliberately tri-state — `undefined` means "unknown", never
 * "absent". Reporting `false` there would be a claim the probe cannot support.
 */
interface InstallCheckResult {
  providerId: LocalProviderName
  /** `true` when the server answered; `undefined` when unreachable (unknown, NOT absent). */
  installed?: boolean
  running: boolean
  version?: string
  error?: string
}
/**
 * Model pull options
 */
interface ModelPullOptions {
  onProgress?: (progress: LocalModelPullProgress) => void
  signal?: AbortSignal
}
/**
 * Get provider capabilities based on provider type
 */
declare function getProviderCapabilities(providerId: LocalProviderName): LocalProviderCapabilities
/**
 * Unified Local Provider Service
 */
declare class LocalProviderService {
  private providerId
  private config
  private baseUrl
  private capabilities
  constructor(providerId: LocalProviderName, baseUrl?: string)
  /**
   * Get provider ID
   */
  getId(): LocalProviderName
  /**
   * Get provider config
   */
  getConfig(): LocalProviderConfig
  /**
   * Get capabilities
   */
  getCapabilities(): LocalProviderCapabilities
  /**
   * Check server status
   */
  getStatus(): Promise<LocalServerStatus>
  /**
   * List available models
   */
  listModels(): Promise<LocalModelInfo[]>
  /**
   * Pull/download a model (Ollama, LocalAI, Jan)
   */
  pullModel(
    modelName: string,
    options?: ModelPullOptions
  ): Promise<{
    success: boolean
    unsubscribe: () => void
  }>
  private pullLocalAIModel
  /**
   * Delete a model
   */
  deleteModel(modelName: string): Promise<boolean>
  /**
   * Stop/unload a model
   */
  stopModel(modelName: string): Promise<boolean>
  /**
   * Generate embeddings
   */
  generateEmbedding(model: string, input: string): Promise<number[]>
}
/**
 * Check installation status for a local provider
 */
declare function checkProviderInstallation(
  providerId: LocalProviderName,
  baseUrl?: string
): Promise<InstallCheckResult>
/**
 * Check all local providers installation status.
 *
 * `baseUrls` overrides the per-provider probe target; anything absent from the
 * map falls back to that provider's default. Callers holding user settings
 * MUST pass it — see the port note in `checkProviderInstallation`.
 */
declare function checkAllProvidersInstallation(
  baseUrls?: Partial<Record<LocalProviderName, string | undefined>>
): Promise<InstallCheckResult[]>
/**
 * Get installation instructions for a provider
 */
declare function getInstallInstructions(providerId: LocalProviderName): {
  title: string
  steps: string[]
  downloadUrl: string
  docsUrl: string
  /** Command that starts the local server. Omitted for GUI apps that expose a server toggle. */
  serveCommand?: string
  /** Example command that fetches a first model. Omitted when models load via a GUI or auto-download. */
  modelPullCommand?: string
  /** Where to browse/download models compatible with this provider. */
  modelsUrl: string
}
/**
 * Create a LocalProviderService instance
 */
declare function createLocalProviderService(
  providerId: LocalProviderName,
  baseUrl?: string
): LocalProviderService

export {
  type InstallCheckResult,
  type LocalProviderCapabilities,
  type LocalProviderInstallInfo,
  LocalProviderService,
  type ModelPullOptions,
  checkAllProvidersInstallation,
  checkProviderInstallation,
  createLocalProviderService,
  LocalProviderService as default,
  getInstallInstructions,
  getProviderCapabilities,
}
