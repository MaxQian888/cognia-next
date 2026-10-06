#!/usr/bin/env node
/**
 * Write the package-owned rows of `protocol/agent-capabilities.json`
 * (ADR-0217).
 *
 * A protocol implemented by an integration package authors its capability row,
 * and its presets their refinements, in that package's `./manifest`; the merge
 * rules live in `lib/agent-ecosystem/capability-catalog.ts`. The JSON stays the
 * ADR-0090 manifest the renderer, CLI, TUI and gates read, so it is generated
 * here and gated with `--check` (run by `pnpm audit:agent-capabilities`).
 *
 * Usage:
 *   node scripts/build/gen-agent-capabilities.mjs          # write the manifest
 *   node scripts/build/gen-agent-capabilities.mjs --check  # fail if it drifted
 */

import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadTsExports, readText, renderJson, REPO_ROOT, writeOrCheck } from "./lib/generated-json.mjs"

const MANIFEST = join(REPO_ROOT, "protocol/agent-capabilities.json")

export async function renderCapabilities() {
  const { mergeIntegrationCapabilityRows, INTEGRATION_CAPABILITIES } = await loadTsExports(`
    export {
      mergeIntegrationCapabilityRows,
      INTEGRATION_CAPABILITIES,
    } from "@/lib/agent-ecosystem/capability-catalog"
  `)
  const current = readText(MANIFEST)
  const merged = mergeIntegrationCapabilityRows(JSON.parse(current), INTEGRATION_CAPABILITIES)
  return { current, next: await renderJson(MANIFEST, merged) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { current, next } = await renderCapabilities()
  process.exitCode = writeOrCheck(MANIFEST, current, next, {
    check: process.argv.includes("--check"),
    label: "gen-agent-capabilities",
    hint: "Edit package-owned rows in packages/agent-<id>/src/manifest.ts, then run: pnpm gen:agent-capabilities",
  })
}
