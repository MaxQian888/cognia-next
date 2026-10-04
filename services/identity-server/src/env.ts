export interface Env {
  DB: D1Database
  /** Origin of this Worker, e.g. http://localhost:8787 or https://id.cognia.cn. */
  BASE_URL: string
  /** RFC 8707 resource identifier of the sync API; becomes the access token `aud`. */
  SYNC_AUDIENCE: string
  BETTER_AUTH_SECRET: string
  /** Guards the spike's /spike/* setup routes. */
  SPIKE_ADMIN_TOKEN: string
  /** The seeded public client the /demo/client page acts as. */
  DEMO_CLIENT_ID?: string
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
}
