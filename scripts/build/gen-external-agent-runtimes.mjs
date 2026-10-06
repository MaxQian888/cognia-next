#!/usr/bin/env node
/**
 * Write the package-owned rows of `protocol/external-agent-runtimes.json`
 * (ADR-0217).
 *
 * A runtime with an integration package authors its catalog row (and any
 * unpinned-launch waiver) in that package's `./manifest`; the merge rules live
 * in `lib/agent-ecosystem/runtime-catalog.ts`. The JSON stays the file the app,
 * Rust, the sandbox image and the bundle tooling read, so it is generated here
 * and gated with `--check` (run by `pnpm audit:external-agent-runtimes`).
 *
 * Usage:
 *   node scripts/build/gen-external-agent-runtimes.mjs          # write the catalog
 *   node scripts/build/gen-external-agent-runtimes.mjs --check  # fail if it drifted
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { format, resolveConfig } from "prettier"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const CATALOG = join(REPO_ROOT, "protocol/external-agent-runtimes.json")

/** Bundle the merge and the manifests (TypeScript behind tsconfig paths) and load them. */
async function loadMerge() {
  const result = await build({
    stdin: {
      contents: `
        export { mergeIntegrationRuntimeRows } from "@/lib/agent-ecosystem/runtime-catalog"
        export { INTEGRATION_MANIFESTS } from "@/lib/agent-ecosystem/catalog"
      `,
      resolveDir: REPO_ROOT,
      loader: "ts",
    },
    absWorkingDir: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "tsconfig.json"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
}

export async function renderCatalog() {
  const { mergeIntegrationRuntimeRows, INTEGRATION_MANIFESTS } = await loadMerge()
  const current = readFileSync(CATALOG, "utf8")
  const merged = mergeIntegrationRuntimeRows(JSON.parse(current), INTEGRATION_MANIFESTS)
  const options = (await resolveConfig(CATALOG)) ?? {}
  // Expanded objects, as the file has always been written; prettier then packs
  // the short arrays.
  const next = await format(JSON.stringify(merged, null, 2), { ...options, filepath: CATALOG })
  return { current, next }
}

async function main() {
  const check = process.argv.includes("--check")
  const { current, next } = await renderCatalog()
  if (current === next) {
    console.log("[gen-external-agent-runtimes] protocol/external-agent-runtimes.json is up to date")
    return
  }
  if (check) {
    console.error(
      "[gen-external-agent-runtimes] protocol/external-agent-runtimes.json differs from the integration manifests. " +
        "Edit package-owned rows in packages/agent-<id>/src/manifest.ts, then run: node scripts/build/gen-external-agent-runtimes.mjs"
    )
    process.exitCode = 1
    return
  }
  writeFileSync(CATALOG, next)
  console.log("[gen-external-agent-runtimes] wrote protocol/external-agent-runtimes.json")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
