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

import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadTsExports, readText, renderJson, REPO_ROOT, writeOrCheck } from "./lib/generated-json.mjs"

const CATALOG = join(REPO_ROOT, "protocol/external-agent-runtimes.json")

export async function renderCatalog() {
  const { mergeIntegrationRuntimeRows, INTEGRATION_MANIFESTS } = await loadTsExports(`
    export { mergeIntegrationRuntimeRows } from "@/lib/agent-ecosystem/runtime-catalog"
    export { INTEGRATION_MANIFESTS } from "@/lib/agent-ecosystem/catalog"
  `)
  const current = readText(CATALOG)
  const merged = mergeIntegrationRuntimeRows(JSON.parse(current), INTEGRATION_MANIFESTS)
  return { current, next: await renderJson(CATALOG, merged) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { current, next } = await renderCatalog()
  process.exitCode = writeOrCheck(CATALOG, current, next, {
    check: process.argv.includes("--check"),
    label: "gen-external-agent-runtimes",
    hint: "Edit package-owned rows in packages/agent-<id>/src/manifest.ts, then run: pnpm gen:external-agent-runtimes",
  })
}
