/**
 * Bindings, variables and secrets of the status Worker.
 *
 * Non-secret configuration is in `wrangler.toml` `[vars]` per environment;
 * secrets are set with `wrangler secret put` and never committed. Every
 * optional value has a documented "absent" behaviour: absence disables the
 * feature it gates, it never widens access.
 */

export interface Env {
  /** D1 history, incidents, subscriptions, outbox, leases. */
  DB: D1Database
  /** Exported `/status` assets (status-only distribution). */
  ASSETS: Fetcher
  /**
   * Cloudflare Email Sending binding. Absent: email capability is off and
   * subscription signup answers `unavailable`.
   */
  EMAIL?: SendEmail

  // --- vars ------------------------------------------------------------------
  /** `production` | `staging` | `development`. */
  STATUS_ENV: string
  /** Public origin of this Worker, e.g. `https://status.cognia.cn`. */
  PUBLIC_ORIGIN: string
  /** Primary public page (`<origin>/status/`). */
  PUBLIC_PAGE_URL: string
  /** Independent read-only mirror page; empty when none is deployed. */
  MIRROR_URL?: string
  /** Signaling WebSocket URL the probes check (public route). */
  SIGNALING_URL: string
  /** Probe ID the Cron trigger records as (`cf-cron`). */
  CLOUDFLARE_PROBE_ID: string
  /**
   * JSON `{ "web": "https://cognia.cn", "ios": "capacitor://localhost",
   * "android": "https://localhost" }`: exact Origins for simulated profiles.
   */
  PROBE_ORIGIN_PROFILES: string
  /** `on` | `off`. Off: no automated incidents are opened or changed. */
  FEATURE_INCIDENT_AUTOMATION: string
  /** `on` | `off`. Off: no subscription signup and no mail sends. */
  FEATURE_EMAIL: string
  /** Verified sender for Cloudflare Email Sending. */
  MAIL_FROM?: string
  MAIL_FROM_NAME?: string
  /** Comma-separated exact Origins allowed to POST subscription actions. */
  SUBSCRIBE_ALLOWED_ORIGINS: string
  /** Subscription abuse limits (integers as strings). */
  SUBSCRIBE_IP_LIMIT_PER_10MIN?: string
  SUBSCRIBE_GLOBAL_CONFIRMATIONS_PER_HOUR?: string
  /** Cloudflare Access team domain, e.g. `https://cognia.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string
  /** Access application audience tag. Absent: every admin request is refused. */
  ACCESS_AUD?: string
  /** Comma-separated operator identities (Access email claim) allowed to write. */
  ADMIN_EMAILS?: string
  /** Current key IDs for subscriber HMAC lookup and email encryption. */
  SUBSCRIBER_HMAC_KEY_ID?: string
  SUBSCRIBER_ENC_KEY_ID?: string
  /** Build identity reported by `/healthz`. */
  BUILD_SHA?: string
  SERVICE_VERSION?: string

  // --- secrets -----------------------------------------------------------------
  /** JSON `{ "<keyId>": "<base64url secret ≥32 bytes>" }` for probe HMAC. */
  PROBE_SECRETS?: string
  /** JSON `{ "<keyId>": "<base64url ≥32 bytes>" }` for the email HMAC index. */
  SUBSCRIBER_HMAC_KEYS?: string
  /** JSON `{ "<keyId>": "<base64url 32 bytes>" }` AES-GCM keys for email at rest. */
  SUBSCRIBER_ENC_KEYS?: string
  /** Secret that salts the ephemeral per-day IP rate buckets. */
  IP_BUCKET_SECRET?: string
  /**
   * Operator alert destination (HTTPS webhook). Fixed by configuration; users
   * can never supply one. Absent: alerts are logged only.
   */
  OPERATOR_ALERT_WEBHOOK?: string
}

export function featureOn(value: string | undefined): boolean {
  return value === "on"
}
