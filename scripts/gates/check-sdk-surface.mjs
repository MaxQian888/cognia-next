#!/usr/bin/env node
/**
 * Gate: the Claude Agent SDK's public surface must match `protocol/agent-sdk-surface.json`.
 *
 * Why this exists: `sidecar/dispatch/anthropic.mjs` builds `query()` options
 * from an explicit allowlist. That is the right design — the sidecar sends
 * protocol-only fields the SDK would reject — but it means a new SDK option is
 * invisible. Nothing breaks, nothing warns; the capability simply does not
 * exist. The same is true of a new `Query` control method, a new `SDKMessage`
 * variant (the renderer's `applySdkEvent` drops unknown ones on its default
 * branch) and a new `HookEvent`.
 *
 * So the gate inverts the default. Every member of the five vocabularies has
 * to be listed here with a `status`, and any member the SDK grows or drops
 * fails the build until a human writes down what it means for Cognia.
 *
 * This is also the certification staleness trigger. `agentSdkVersion`
 * participates in `CompatibilityRecordKey`, so bumping the SDK invalidates
 * every existing compatibility record by design (ADR-0090 §8). Keeping the
 * manifest's `sdkVersion` pinned to the installed one makes that coupling
 * mechanical instead of remembered.
 *
 * Usage:
 *   pnpm check:sdk-surface           verify (CI + check:all)
 *   pnpm check:sdk-surface:write     re-triage after an intentional bump
 *
 * `--write` preserves existing verdicts and stubs new members as `planned`, so
 * a regenerate can never silently mark something supported.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { extractSurface, diffSurface, SURFACE_KINDS, TRIAGED_KINDS } from "./lib/sdk-surface.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MANIFEST_PATH = join(REPO_ROOT, "protocol", "agent-sdk-surface.json")
const SDK_DIR = join(REPO_ROOT, "sidecar", "node_modules", "@anthropic-ai", "claude-agent-sdk")
const DTS_PATH = join(SDK_DIR, "sdk.d.ts")

/**
 * A missing manifest is not an error here: `--write` has to be able to
 * bootstrap one. `verify` is what rejects it.
 *
 * @param {(p: string) => string} read
 */
export function loadInputs(read = (p) => readFileSync(p, "utf8")) {
  const source = read(DTS_PATH)
  const installedVersion = JSON.parse(read(join(SDK_DIR, "package.json"))).version

  let manifest = null
  try {
    manifest = JSON.parse(read(MANIFEST_PATH))
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  return { source, installedVersion, manifest }
}

/**
 * Merge a freshly extracted surface into an existing manifest, keeping every
 * verdict already recorded. New members arrive as `planned` — never
 * `supported` — because a regenerate must not be able to claim coverage that
 * no one implemented.
 *
 * @param {Record<string, string[]>} surface
 * @param {any} previous
 * @param {string} sdkVersion
 */
export function buildManifest(surface, previous, sdkVersion) {
  const prior = previous?.surface ?? {}
  /** @type {Record<string, unknown>} */
  const next = {}

  for (const kind of SURFACE_KINDS) {
    const members = surface[kind] ?? []
    if (!TRIAGED_KINDS.includes(kind)) {
      next[kind] = [...members].sort()
      continue
    }
    const priorEntries = prior[kind] ?? {}
    next[kind] = Object.fromEntries(
      [...members].sort().map((name) => [name, priorEntries[name] ?? { status: "planned" }])
    )
  }

  return {
    $schema: "./agent-sdk-surface.schema.json",
    schemaVersion: 1,
    sdkVersion,
    generatedBy: "pnpm check:sdk-surface:write",
    surface: next,
  }
}

/**
 * @param {{ source: string, installedVersion: string, manifest: any }} inputs
 * @returns {string[]} human-readable failures, empty when the gate passes
 */
export function verify({ source, installedVersion, manifest }) {
  const errors = []

  if (!manifest) {
    return ["protocol/agent-sdk-surface.json is missing — run `pnpm check:sdk-surface:write`"]
  }

  if (manifest.sdkVersion !== installedVersion) {
    errors.push(
      `sdkVersion drift: manifest says ${manifest.sdkVersion}, ` +
        `sidecar/node_modules has ${installedVersion}`
    )
  }

  const surface = extractSurface(source)
  for (const { kind, added, removed, badStatus } of diffSurface(surface, manifest)) {
    if (added.length) {
      errors.push(
        `${kind}: ${added.length} member(s) the SDK has and the manifest does not:\n` +
          added.map((n) => `      + ${n}`).join("\n")
      )
    }
    if (removed.length) {
      errors.push(
        `${kind}: ${removed.length} member(s) the manifest has and the SDK does not:\n` +
          removed.map((n) => `      - ${n}`).join("\n")
      )
    }
    if (badStatus.length) {
      errors.push(
        `${kind}: ${badStatus.length} entr(ies) with a missing or invalid status:\n` +
          badStatus.map((n) => `      ? ${n}`).join("\n")
      )
    }
  }

  return errors
}

export function main(argv = process.argv.slice(2)) {
  let inputs
  try {
    inputs = loadInputs()
  } catch (err) {
    if (err.code === "ENOENT" && err.path === DTS_PATH) {
      console.error(
        "[sdk-surface] the Agent SDK is not installed.\n" + "  Run: pnpm sidecar:install"
      )
      return 1
    }
    if (err.code === "ENOENT" && err.path === MANIFEST_PATH) {
      console.error(
        "[sdk-surface] protocol/agent-sdk-surface.json is missing.\n" +
          "  Run: pnpm check:sdk-surface:write"
      )
      return 1
    }
    throw err
  }

  if (argv.includes("--write")) {
    const surface = extractSurface(inputs.source)
    const manifest = buildManifest(surface, inputs.manifest, inputs.installedVersion)
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n")
    const counts = SURFACE_KINDS.map((k) => `${k}=${surface[k].length}`).join(" ")
    console.log(`[sdk-surface] wrote manifest for ${inputs.installedVersion} (${counts})`)
    return 0
  }

  const errors = verify(inputs)
  if (errors.length) {
    console.error(`[sdk-surface] the SDK surface drifted from the manifest:`)
    for (const e of errors) console.error(`  ${e}`)
    console.error(
      "\n  A new member means a capability nobody triaged yet. Decide what it\n" +
        "  means for the unified execution contract, then run\n" +
        "  `pnpm check:sdk-surface:write` and set its status. Note that any SDK\n" +
        "  version change also invalidates every certification bundle\n" +
        "  (ADR-0090 §8) — plan to recertify."
    )
    return 1
  }

  const surface = extractSurface(inputs.source)
  const counts = SURFACE_KINDS.map((k) => `${k} ${surface[k].length}`).join(", ")
  console.log(`[sdk-surface] OK — ${inputs.installedVersion}: ${counts}`)
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-sdk-surface.mjs")
) {
  process.exit(main())
}
