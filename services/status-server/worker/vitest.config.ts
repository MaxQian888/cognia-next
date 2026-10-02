import path from "node:path"

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Runs inside workerd (miniflare) with a local D1 that has every migration
// applied (test/apply-migrations.ts), so the SQL the Worker issues is
// exercised for real. Secrets are injected here; none are real.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"))
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // 32-byte keys, base64url. Test-only values.
            PROBE_SECRETS: JSON.stringify({
              "ext-test-k1": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
              "ext-test-k2": "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
            }),
            SUBSCRIBER_HMAC_KEYS: JSON.stringify({
              h1: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
            }),
            SUBSCRIBER_ENC_KEYS: JSON.stringify({
              e1: "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8",
            }),
            IP_BUCKET_SECRET: "test-ip-bucket-secret-0123456789abcdef",
          },
          d1Databases: { DB: ":memory:" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  }
})
