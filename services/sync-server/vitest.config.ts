import { generateKeyPairSync } from "node:crypto"

import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Runs inside workerd (miniflare). A throwaway ES256 issuer key is made per
// run: the tests sign access tokens with its private half (TEST_SIGNING_JWK),
// and the stubbed IDENTITY binding serves its public half as the JWKS.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
const kid = "test-key-1"
const privateJwk = { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256" }
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml", environment: "test" },
      miniflare: {
        bindings: { TEST_SIGNING_JWK: JSON.stringify(privateJwk) },
        serviceBindings: {
          IDENTITY: async (request: Request) => {
            const { pathname } = new URL(request.url)
            if (pathname === "/api/auth/jwks") return Response.json({ keys: [publicJwk] })
            return new Response("not found", { status: 404 })
          },
        },
      },
    }),
  ],
})
