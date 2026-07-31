import { createMDX } from "fumadocs-mdx/next"
import type { NextConfig } from "next"

const config: NextConfig = {
  // D8 (ADR-0059 P0.6): the docs site is a fully static export so it can be
  // hosted on Cloudflare Pages (`wrangler pages deploy docs/out`). Locale
  // prefixes are always explicit (`hideLocale: "never"`) because there is no
  // middleware at runtime; `public/_redirects` sends `/` to the default
  // locale on Pages.
  output: "export",
  reactStrictMode: true,
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]"],
}

const withMDX = createMDX()

export default withMDX(config)
