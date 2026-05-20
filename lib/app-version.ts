/**
 * Single source of truth for the running app version.
 *
 * Next.js inlines this constant at build time via the `process.env`-based
 * version bridge below; in test / dev mode it falls back to the package.json
 * default that ships in the source tree. Importing the constant is preferred
 * over reading `process.env` directly so consumers don't need to defend
 * against `undefined` on every call site.
 */

import pkg from "../package.json" with { type: "json" }

export const APP_VERSION: string = pkg.version as string
