import type { SyncAdminBinding } from "./deletion/purge"

/** Bindings, vars and secrets of the identity Worker (see wrangler.toml). */
export interface Env {
  DB: D1Database
  /** The sync Worker's `SyncAdmin` entrypoint; deletes a person's sync space on purge. Optional. */
  SYNC_ADMIN?: SyncAdminBinding
  SERVICE_ENV: string
  /** Origin of this Worker, e.g. https://id.cognia.cn. The issuer is `${BASE_URL}/api/auth`. */
  BASE_URL: string
  /** RFC 8707 resource of the sync API; becomes the access-token `aud`. */
  SYNC_AUDIENCE: string
  /** Comma-separated exact origins of the official web app. */
  WEB_ORIGINS: string
  ACCOUNT_DELETION_COOLING_OFF_DAYS?: string
  /** Versioned secrets, `"<version>:<value>,…"`, newest first. */
  BETTER_AUTH_SECRETS?: string
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  APPLE_SERVICE_ID?: string
  APPLE_TEAM_ID?: string
  APPLE_KEY_ID?: string
  APPLE_PRIVATE_KEY?: string
  APPLE_APP_BUNDLE_ID?: string
}
