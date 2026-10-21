/**
 * The plugin contract's share of `lib/plugin/auth/auth-provider-registry.ts`, which re-exports these.
 */
export interface AuthSession {
  /** Stable id assigned when the session was created. */
  id: string
  /** Bearer token / API key. Persisted via cognia's secrets API. */
  accessToken: string
  /** Account identifier — typically email or user-id. */
  account: { id: string; label: string }
  /** Scopes granted with this session. Sorted for deterministic comparison. */
  scopes: string[]
}

export interface AuthSessionChangeEvent {
  added: AuthSession[]
  removed: AuthSession[]
  changed: AuthSession[]
}

export interface AuthSessionOptions {
  createIfNone?: boolean
  forceNewSession?: boolean
  silent?: boolean
  clearSessionPreference?: boolean
  /** Provider-specific setup values collected by a host-owned form. */
  configuration?: Record<string, unknown>
}
