import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Runs inside workerd (miniflare) with a local D1 so the SQL the Worker
// actually issues is exercised, not a mock of it.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { UPDATE_ADMIN_SECRET: "test-admin-secret" },
        d1Databases: { UPDATE_DB: ":memory:" },
      },
    }),
  ],
})
