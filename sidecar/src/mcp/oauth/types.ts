import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { EgressGuard, EgressGuardOptions } from "../../platform/net/egress-guard.ts"

export interface AuthState {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  codeVerifier?: string
  expiresAtMs?: number
  [field: string]: unknown
}
export interface ProviderDeps {
  redirectUrl: string
  clientName?: string
  scope?: string
  state?: string
  onRedirect?: (url: URL) => void | Promise<void>
}
export interface CallbackResult {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}
export interface CallbackServer {
  redirectUrl: string
  waitForCode(timeoutMs: number): Promise<CallbackResult>
  close(): void
}
export interface RemoteServer {
  transport?: string
  config?: {
    url?: unknown
    allowPrivateNetwork?: boolean
    headers?: Record<string, string>
    scope?: string
  }
}
export type OAuthTransport = Transport & { finishAuth?(code: string): Promise<void> }
export interface OAuthClient {
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
}
export interface TransportOptions {
  fetch: EgressGuard["fetch"]
  requestInit: RequestInit
  authProvider?: OAuthClientProvider
}
export interface OAuthSdk {
  Client: new (
    info: { name: string; version: string },
    options: { capabilities: Record<string, never> }
  ) => OAuthClient
  StreamableHTTPClientTransport: new (url: URL, options?: TransportOptions) => OAuthTransport
  SSEClientTransport: new (url: URL, options?: TransportOptions) => OAuthTransport
}
export interface FlowInput {
  server: RemoteServer
  entry?: AuthState
  mode?: "authenticate" | "refresh"
}
export interface HeadlessInput extends FlowInput {
  redirectUrl?: string
  state?: string
  code?: string
}
export interface FlowResult {
  result: {
    ok: boolean
    status: "error" | "unsupported" | "authorized" | "denied" | "pending"
    message: string
  }
  entry: AuthState | undefined
  authorizationUrl?: string
}
export interface FlowDeps extends EgressGuardOptions {
  createEgressGuard?: (options: EgressGuardOptions) => EgressGuard
  startCallbackServer?: () => Promise<CallbackServer>
  openBrowser?: (url: string) => void
  onAuthUrl?: (url: string) => unknown
  timeoutMs?: number
  sdk?: OAuthSdk
  randomState?: () => string
}
export interface HeadlessStageContext {
  client: OAuthClient
  transport: OAuthTransport
  authState: AuthState
  getAuthorizationUrl(): string | undefined
}
export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
