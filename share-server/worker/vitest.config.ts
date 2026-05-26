import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

// Runs the suite inside workerd (miniflare) so R2 + KV bindings behave like
// production. Bindings are taken from wrangler.toml; the bearer secret is
// injected here so tests don't depend on `wrangler secret`.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { SHARE_UPLOAD_SECRET: "test-secret" },
        },
      },
    },
  },
})
