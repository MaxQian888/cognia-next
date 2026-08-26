import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Runs the suite inside workerd (miniflare) so R2 + KV bindings behave like
// production. Bindings are taken from wrangler.toml; the bearer secret is
// injected here so tests don't depend on `wrangler secret`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          SHARE_UPLOAD_SECRET: "test-secret",
          // 32 bytes ("0123456789abcdef" twice), matching the grant
          // verifier's key floor and the Rust test config, so the ADR-0149
          // org plane is exercised here rather than only in production.
          SHARE_GRANT_KEY: "3031323334353637383961626364656630313233343536373839616263646566",
        },
      },
    }),
  ],
})
