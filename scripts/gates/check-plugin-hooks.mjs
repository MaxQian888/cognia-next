#!/usr/bin/env node
/**
 * Static audit for plugin hook points: does every hook the contract calls
 * `implemented` actually have a fire site, and does every hook it calls
 * `virtual` actually lack one?
 *
 * Why this exists: `hookPointContracts` in
 * `lib/plugin/contracts/plugin-points.ts` is SYNTHESIZED — it maps every
 * canonical hook name through one object literal. Before `VIRTUAL_HOOK_POINTS`
 * landed, that literal hardcoded `status: "implemented"`, `stability:
 * "stable"` and a single shared `binding`, so all 139 hooks asserted they were
 * live and bound to `hooks-system.ts`. Ten of them were fired nowhere in the
 * repo. A plugin author registering `onScheduledTaskBeforeRun` got accepting
 * SDK types, a contract claiming stable+implemented, and a handler that never
 * ran. Nothing could catch it: the UI-slot audit covers `ui-slot` points only,
 * and no gate looked at hooks at all.
 *
 * The check is deliberately two-directional. Requiring only that implemented
 * hooks fire would let the dormancy label rot the other way — someone wires
 * `onScheduledTaskCreate` up properly and forgets to remove it from
 * `VIRTUAL_HOOK_POINTS`, and the contract keeps telling plugin authors the
 * hook is dead while it is quietly working.
 *
 * A "fire site" is a mention of the hook name in the binding file. That is a
 * weaker test than proving the call is reachable, but it is sufficient for the
 * defect this gate exists to catch: a hook name that appears nowhere in the
 * host cannot possibly fire.
 *
 * Usage:
 *   pnpm audit:hooks          # exit 0 if green, 1 if red
 *   pnpm audit:hooks --json   # machine-readable JSON to stdout
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const CONTRACT_FILE = "lib/plugin/contracts/plugin-points.ts"

/**
 * Parse the canonical hook list and the virtual set straight out of the
 * contract source. Importing the module instead would drag the whole plugin
 * runtime (and its `@/` aliases) into a plain `node` gate.
 */
export function parseContract(source) {
  const hookBlock = source.match(/CANONICAL_HOOK_POINTS\s*=\s*\[([\s\S]*?)\n\]/)
  if (!hookBlock) throw new Error(`CANONICAL_HOOK_POINTS not found in ${CONTRACT_FILE}`)
  const hooks = [
    ...hookBlock[1]
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .matchAll(/"(on[A-Za-z0-9]+)"/g),
  ].map((m) => m[1])

  const virtualBlock = source.match(
    /VIRTUAL_HOOK_POINTS\s*=\s*new Set<CanonicalHookPoint>\(\[([\s\S]*?)\n\]\)/
  )
  if (!virtualBlock) throw new Error(`VIRTUAL_HOOK_POINTS not found in ${CONTRACT_FILE}`)
  const virtual = [
    ...virtualBlock[1]
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .matchAll(/"(on[A-Za-z0-9]+)"/g),
  ].map((m) => m[1])

  const binding = source.match(/HOOK_POINT_BINDING\s*=\s*"([^"]+)"/)
  if (!binding) throw new Error(`HOOK_POINT_BINDING not found in ${CONTRACT_FILE}`)

  return { hooks, virtual, binding: binding[1] }
}

/** A hook fires if the binding file mentions it as a whole word. */
export function hasFireSite(bindingSource, hook) {
  return new RegExp(`\\b${hook}\\b`).test(bindingSource)
}

export function evaluate({ hooks, virtual, bindingSource, binding }) {
  const virtualSet = new Set(virtual)
  const errors = []

  const unknownVirtual = virtual.filter((h) => !hooks.includes(h))
  for (const hook of unknownVirtual) {
    errors.push(
      `[virtual-unknown] "${hook}" is in VIRTUAL_HOOK_POINTS but is not a canonical hook point.`
    )
  }

  for (const hook of hooks) {
    const fires = hasFireSite(bindingSource, hook)
    if (virtualSet.has(hook) && fires) {
      errors.push(
        `[virtual-but-fired] "${hook}" is marked virtual but ${binding} mentions it. ` +
          `If the hook is wired now, remove it from VIRTUAL_HOOK_POINTS so the contract stops telling plugin authors it is dead.`
      )
    } else if (!virtualSet.has(hook) && !fires) {
      errors.push(
        `[implemented-never-fired] "${hook}" is contracted as implemented but ${binding} never mentions it, ` +
          `so a plugin handler registered for it can never run. Either fire it, or add it to VIRTUAL_HOOK_POINTS.`
      )
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    total: hooks.length,
    virtual: virtual.filter((h) => hooks.includes(h)).length,
  }
}

export function runAudit(repoRoot = REPO_ROOT) {
  const source = readFileSync(join(repoRoot, CONTRACT_FILE), "utf8")
  const { hooks, virtual, binding } = parseContract(source)
  const bindingSource = readFileSync(join(repoRoot, binding), "utf8")
  return evaluate({ hooks, virtual, bindingSource, binding })
}

function main() {
  const report = runAudit()
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
  } else if (report.ok) {
    console.log(
      `[plugin-hooks] PASS — ${report.total} hook points (${report.virtual} virtual, ${report.total - report.virtual} fired).`
    )
  } else {
    console.error(`[plugin-hooks] FAIL — ${report.errors.length} problem(s):`)
    for (const err of report.errors) console.error(`  ${err}`)
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
