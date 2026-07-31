import type { NextConfig } from "next"

// ADR-0092: the marketing site is a fully static export hosted on its own
// Cloudflare Pages project (`wrangler pages deploy web/out`). There is no
// middleware at runtime, so every locale path is generated at build time and
// `public/_redirects` carries the `/en/* -> /` rule on Pages.
const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]"],
}

export default config
