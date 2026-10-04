import path from "node:path"

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Runs inside workerd (miniflare) with a local D1 that has every migration
// applied (test/apply-migrations.ts), so the SQL Better Auth issues is
// exercised for real. Secrets are injected here; none are real, and every
// provider's outbound fetch is stubbed by the tests that need it.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"))
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRETS:
              "2:test-secret-two-0123456789abcdefghijklmnopqrstuvwxyz,1:test-secret-one-0123456789abcdefghijklmnopqrstuvwxyz",
            FEISHU_APP_ID: "cli_test_feishu",
            FEISHU_APP_SECRET: "test-feishu-secret",
            GITHUB_CLIENT_ID: "test-github-client",
            GITHUB_CLIENT_SECRET: "test-github-secret",
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
