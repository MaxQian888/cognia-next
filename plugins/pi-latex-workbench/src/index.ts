/**
 * Pi LaTeX Workbench — installable desktop plugin.
 *
 * Everything this plugin contributes is declarative and lives in plugin.json:
 * the `latexwb_*` cliTools (materialized by the manager into registry tools
 * that run through `lib/plugin/cli-tools` — cli:execute consent showing the
 * expanded command, binary detection, injection-proof argv, audit), the
 * local-bundle skills, the configuration schema and the `piPackages` entry
 * (ADR-0210). Activation therefore has no work to do.
 *
 * Not bundled with the app: `build.mjs` compiles this file to `dist/index.js`
 * (the manifest's `main`, gitignored build output) and packs the install ZIP
 * from the `bundle_include` allowlist. The desktop loader evaluates `main` as
 * CommonJS, so the plugin cannot load from its directory until that build has
 * run — see the README.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async () => {},
})
