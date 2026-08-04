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

import {
  extractSurface,
  extractMessageDiscriminants,
  diffSurface,
  SURFACE_KINDS,
  TRIAGED_KINDS,
} from "./lib/sdk-surface.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MANIFEST_PATH = join(REPO_ROOT, "protocol", "agent-sdk-surface.json")
const SDK_DIR = join(REPO_ROOT, "sidecar", "node_modules", "@anthropic-ai", "claude-agent-sdk")
const DTS_PATH = join(SDK_DIR, "sdk.d.ts")
const CONTRACT_PATH = join(REPO_ROOT, "packages", "agent-config-types", "src", "agent-execution.ts")
const CONTRACT_INDEX_PATH = join(REPO_ROOT, "packages", "agent-config-types", "src", "index.ts")

/**
 * String literals of `const CANONICAL_EVENT_KINDS: readonly string[] = [ … ]`.
 *
 * Read out of the TS source rather than imported because this gate runs as
 * plain `.mjs` under `node --test`, with no TS pipeline available.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function extractCanonicalEventKinds(source) {
  const body = source.match(/CANONICAL_EVENT_KINDS: readonly string\[\] = \[([\s\S]*?)\n\]/)?.[1]
  if (!body) throw new Error("agent-execution.ts: `CANONICAL_EVENT_KINDS` not found")
  return new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
}

/**
 * String literals of an `export const NAME = [ … ] as const` array.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string[]}
 */
export function extractConstStringArray(source, name) {
  const body = source.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\] as const`)
  )?.[1]
  if (!body) throw new Error(`index.ts: \`${name}\` not found`)
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/**
 * The contract's discriminant vocabulary must equal the SDK's.
 *
 * `SDKMessage` in `@cognia/agent-config-types` is an OPEN union — it ends in a
 * catch-all so a host one version ahead cannot break the build. That openness
 * makes `switch` exhaustiveness structurally impossible, which is how 30 of the
 * 39 union members sat on a default branch for eight SDK releases. Consumers
 * therefore assert exhaustiveness against `SDK_MESSAGE_TYPES` /
 * `SDK_SYSTEM_SUBTYPES`, and those lists are only trustworthy if something
 * proves they still match the installed `sdk.d.ts`. This is that something.
 *
 * @param {string} contractSource `packages/agent-config-types/src/index.ts`
 * @param {Record<string, { type: string, subtypes: string[] }>} discriminants
 * @returns {string[]}
 */
export function verifyDiscriminantVocabulary(contractSource, discriminants) {
  const members = Object.values(discriminants)
  const expected = {
    SDK_MESSAGE_TYPES: [...new Set(members.map((m) => m.type))].sort(),
    SDK_SYSTEM_SUBTYPES: [
      ...new Set(members.filter((m) => m.type === "system").flatMap((m) => m.subtypes)),
    ].sort(),
    // The turn's five possible endings. Pinned for the same reason as the two
    // above, and load-bearing for structured output: three of the five are
    // failures a caller must tell apart, and one of those three arrives
    // wearing `subtype: "success"`.
    SDK_RESULT_SUBTYPES: [
      ...new Set(members.filter((m) => m.type === "result").flatMap((m) => m.subtypes)),
    ].sort(),
  }

  const errors = []
  for (const [name, want] of Object.entries(expected)) {
    const declared = [...extractConstStringArray(contractSource, name)].sort()
    const missing = want.filter((v) => !declared.includes(v))
    const extra = declared.filter((v) => !want.includes(v))
    if (missing.length) {
      errors.push(
        `${name}: missing ${missing.join(", ")} — the SDK emits ${missing.length > 1 ? "these" : "this"}`
      )
    }
    if (extra.length) {
      errors.push(`${name}: declares ${extra.join(", ")}, which the SDK does not emit`)
    }
  }
  return errors
}

/**
 * A missing manifest is not an error here: `--write` has to be able to
 * bootstrap one. `verify` is what rejects it.
 *
 * @param {(p: string) => string} read
 */
export function loadInputs(read = (p) => readFileSync(p, "utf8")) {
  const source = read(DTS_PATH)
  const installedVersion = JSON.parse(read(join(SDK_DIR, "package.json"))).version
  const canonicalKinds = extractCanonicalEventKinds(read(CONTRACT_PATH))
  const contractSource = read(CONTRACT_INDEX_PATH)

  let manifest = null
  try {
    manifest = JSON.parse(read(MANIFEST_PATH))
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  return { source, installedVersion, manifest, canonicalKinds, contractSource }
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
export function buildManifest(surface, previous, sdkVersion, discriminants = {}) {
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
      [...members].sort().map((name) => {
        const entry = { ...(priorEntries[name] ?? { status: "planned" }) }
        // `wire` is derived from the SDK, not a human verdict — always refresh
        // it. `canonical` IS a verdict and is preserved; a new member gets an
        // empty list, which `verify` then rejects for anything claiming
        // `supported`.
        if (kind === "messages" && discriminants[name]) {
          const d = discriminants[name]
          entry.wire = d.subtypes?.length
            ? { type: d.type, subtypes: d.subtypes }
            : { type: d.type }
          entry.canonical = entry.canonical ?? []
        }
        return [name, entry]
      })
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
 * The manifest's per-message `wire` / `canonical` triage.
 *
 * `wire` is checked against the `.d.ts` because the union has 39 members but
 * only 11 distinct `type` values — a rename that keeps the interface name and
 * changes the discriminant would otherwise pass unnoticed while every consumer
 * silently stopped matching.
 *
 * `canonical` is the anti-dormancy half: a message may not be called
 * `supported` without naming the canonical event kind(s) it becomes. "Handled"
 * with nothing on the other side is exactly the default-branch swallow this
 * gate exists to prevent.
 *
 * @param {Record<string, any>} entries
 * @param {Record<string, { type: string, subtypes: string[] }>} discriminants
 * @param {Set<string>} canonicalKinds
 * @returns {string[]}
 */
export function verifyMessageMapping(entries, discriminants, canonicalKinds) {
  const errors = []

  for (const [name, entry] of Object.entries(entries)) {
    const actual = discriminants[name]
    if (!actual) continue // membership drift is already reported by diffSurface

    const wire = entry?.wire
    if (!wire || typeof wire.type !== "string") {
      errors.push(`${name}: missing \`wire.type\``)
    } else if (wire.type !== actual.type) {
      errors.push(`${name}: wire.type is "${wire.type}", the SDK says "${actual.type}"`)
    }

    const declared = [...(wire?.subtypes ?? [])].sort().join(",")
    const real = [...actual.subtypes].sort().join(",")
    if (declared !== real) {
      errors.push(`${name}: wire.subtypes [${declared}] but the SDK has [${real}]`)
    }

    const canonical = entry?.canonical
    if (!Array.isArray(canonical)) {
      errors.push(`${name}: missing \`canonical\` (an array of canonical event kinds)`)
      continue
    }
    if (entry.status === "supported" && canonical.length === 0) {
      errors.push(`${name}: marked "supported" but maps to no canonical event kind`)
    }
    for (const kind of canonical) {
      if (!canonicalKinds.has(kind)) {
        errors.push(`${name}: canonical kind "${kind}" is not in CANONICAL_EVENT_KINDS`)
      }
    }
  }

  return errors
}

/**
 * @param {{
 *   source: string,
 *   installedVersion: string,
 *   manifest: any,
 *   canonicalKinds?: Set<string>,
 *   contractSource?: string,
 * }} inputs
 * @returns {string[]} human-readable failures, empty when the gate passes
 */
export function verify({
  source,
  installedVersion,
  manifest,
  canonicalKinds = new Set(),
  contractSource,
}) {
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

  const discriminants = extractMessageDiscriminants(source)
  errors.push(
    ...verifyMessageMapping(manifest.surface?.messages ?? {}, discriminants, canonicalKinds)
  )
  if (contractSource) {
    errors.push(...verifyDiscriminantVocabulary(contractSource, discriminants))
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
    const manifest = buildManifest(
      surface,
      inputs.manifest,
      inputs.installedVersion,
      extractMessageDiscriminants(inputs.source)
    )
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
