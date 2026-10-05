import type { SyncSpace } from "./space"

/** Bindings and vars of the sync Worker (see wrangler.toml). */
export interface Env {
  SYNC_SPACE: DurableObjectNamespace<SyncSpace>
  /**
   * The identity Worker of this environment, for its JWKS. Absent in local
   * dev and self-host, where the JWKS is fetched from `ISSUER` over the network.
   */
  IDENTITY?: Fetcher
  SERVICE_ENV: string
  /** The issuer whose access tokens this Worker accepts, e.g. https://id.cognia.cn/api/auth. */
  ISSUER: string
  /** The access-token audience (RFC 8707 resource) of the sync API. */
  SYNC_AUDIENCE: string
  /** Comma-separated exact origins of the official web app (CORS). */
  WEB_ORIGINS: string
}
