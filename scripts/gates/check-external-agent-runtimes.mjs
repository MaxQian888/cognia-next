#!/usr/bin/env node
/**
 * Gate: the external-agent runtime catalog governs every shipped runtime.
 *
 * The install-side twin of `check-agent-capabilities.mjs`. That gate keeps the
 * launch allowlist honest across TypeScript and Rust; this one keeps the
 * INSTALL story honest — which runtimes exist, where their bytes come from,
 * which versions may run, and what is still ungoverned.
 *
 * Why it exists: presets described commands, and nothing described runtimes. A
 * preset could be added with an unpinned `npx -y <pkg>` launch, no version
 * probe, no supported range, no install receipt and no uninstall path, and
 * every existing gate would stay green. Four shipped presets are in exactly
 * that state today, which is why `unpinnedLaunchWaivers` exists: a hole that is
 * named and counted can be closed, one that is invisible cannot.
 *
 * What is checked:
 *   1. schema — every entry has the fields its ownership mode requires;
 *   2. coverage — every shipped preset maps to exactly one runtime, and no
 *      catalog entry names a preset that does not exist;
 *   3. pinning — every declared distribution has an EXACT version plus an
 *      approved frozen lock (package managers) or an https URL and a SHA-256
 *      (binaries). A range, a dist-tag, or a missing digest fails;
 *   4. lock assets — every referenced lock file exists on disk and its bytes
 *      hash to the digest the catalog claims;
 *   5. waivers — every unpinned launch is waived with a written reason, and no
 *      waiver names a runtime that is already pinned (the list may only shrink);
 *   6. launch parity — every non-package-runner launch command is in the
 *      security policy's binary allowlist, and every package-runner launch
 *      names a package in the npx allowlist;
 *   7. platform sanity — Windows-eligible runtimes support Windows, and no
 *      runtime claims a platform outside the known set.
 *
 * What is NOT checked, and why: whether a version listed as certified actually
 * behaves. That is a runtime property no static gate can establish, and a check
 * claiming otherwise would read as coverage it does not have. It is pinned by
 * `lib/ai/agent/external/runtime-version.test.ts` at the policy level and by
 * the provider conformance tests at the install level.
 *
 * Usage: pnpm audit:external-agent-runtimes
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")
const readJson = (rel) => JSON.parse(read(rel))

const CATALOG = "protocol/external-agent-runtimes.json"
const SECURITY_POLICY = "protocol/external-agent-security-policy.json"
const PRESETS_TS = "lib/ai/agent/external/presets.ts"

const KNOWN_PLATFORMS = new Set(["darwin", "linux", "win32"])
const OWNERSHIP_MODES = new Set(["managed", "system", "remote"])
const JS_PROVIDERS = new Set(["npm", "pnpm", "bun"])
const ALL_PROVIDERS = new Set([...JS_PROVIDERS, "uvx", "binary"])
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"])
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

/** Preset ids the app actually ships, read from the preset union. */
export function shippedPresetIds(presetsSource) {
  const match = /export type ExternalAgentPresetId =([\s\S]*?)\n\n/.exec(presetsSource)
  if (!match) return []
  return [...match[1].matchAll(/"([^"]+)"/g)]
    .map((entry) => entry[1])
    .filter((id) => id !== "custom")
}

/** Strip a Windows executable suffix and lower-case, as both launchers do. */
function baseCommand(command) {
  return command
    .trim()
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "")
}

function isPackageRunner(command) {
  return PACKAGE_RUNNERS.has(baseCommand(command))
}

export function checkSchema(catalog) {
  const errors = []
  if (typeof catalog.version !== "number") errors.push(`${CATALOG}: missing numeric "version"`)
  if (!Array.isArray(catalog.runtimes)) {
    errors.push(`${CATALOG}: missing "runtimes" array`)
    return errors
  }

  const seen = new Set()
  for (const entry of catalog.runtimes) {
    const id = entry.runtimeId
    if (!id) {
      errors.push(`${CATALOG}: an entry has no runtimeId`)
      continue
    }
    if (seen.has(id)) errors.push(`${id}: duplicate runtimeId`)
    seen.add(id)

    if (!OWNERSHIP_MODES.has(entry.ownership)) {
      errors.push(`${id}: ownership must be managed | system | remote`)
    }
    if (!Array.isArray(entry.presetIds)) errors.push(`${id}: presetIds must be an array`)
    if (!entry.displayName) errors.push(`${id}: missing displayName`)
    if (!entry.protocol) errors.push(`${id}: missing protocol`)
    if (!entry.transport) errors.push(`${id}: missing transport`)
    if (!Array.isArray(entry.distributions)) errors.push(`${id}: distributions must be an array`)
    if (!entry.sandbox || typeof entry.sandbox.required !== "boolean") {
      errors.push(`${id}: missing sandbox.required`)
    }

    if (entry.ownership === "system" && !entry.systemCommand) {
      errors.push(`${id}: a system runtime must name the command it launches`)
    }
    if (entry.ownership === "remote" && entry.systemCommand) {
      errors.push(`${id}: a remote runtime launches nothing locally but names a systemCommand`)
    }
    if (entry.ownership !== "remote" && !entry.versionProbe) {
      errors.push(`${id}: a locally-launched runtime must declare how to read its version`)
    }
    if (entry.versionProbe) {
      if (!Array.isArray(entry.versionProbe.args)) errors.push(`${id}: versionProbe.args missing`)
      if (!entry.versionProbe.parser) errors.push(`${id}: versionProbe.parser missing`)
      if (!(entry.versionProbe.timeoutMs > 0)) {
        // An unbounded probe hangs the connect path rather than failing it.
        errors.push(`${id}: versionProbe.timeoutMs must be a positive bound`)
      }
    }
    if (entry.certifiedVersions && !entry.supportedRange) {
      errors.push(`${id}: certifiedVersions without a supportedRange to sit inside`)
    }
    for (const version of entry.certifiedVersions ?? []) {
      if (!EXACT_VERSION.test(version)) {
        errors.push(`${id}: certified version "${version}" is not an exact version`)
      }
    }
  }
  return errors
}

export function checkCoverage(catalog, presetsSource) {
  const errors = []
  const shipped = new Set(shippedPresetIds(presetsSource))
  const claimed = new Map()

  for (const entry of catalog.runtimes) {
    for (const presetId of entry.presetIds ?? []) {
      if (claimed.has(presetId)) {
        errors.push(
          `preset "${presetId}" is claimed by both ${claimed.get(presetId)} and ${entry.runtimeId}`
        )
      }
      claimed.set(presetId, entry.runtimeId)
      if (!shipped.has(presetId)) {
        errors.push(`${entry.runtimeId}: names preset "${presetId}", which the app does not ship`)
      }
    }
  }

  for (const presetId of shipped) {
    if (!claimed.has(presetId)) {
      // A preset with no catalog entry has no version policy, no install story
      // and no uninstall story.
      errors.push(`preset "${presetId}" has no runtime catalog entry`)
    }
  }
  return errors
}

export function checkPinning(catalog, { fileExists = existsSync, readFile = readFileSync } = {}) {
  const errors = []

  for (const entry of catalog.runtimes) {
    for (const distribution of entry.distributions ?? []) {
      const id = `${entry.runtimeId}/${distribution.provider}`

      if (!ALL_PROVIDERS.has(distribution.provider)) {
        errors.push(`${id}: unknown provider`)
        continue
      }

      if (!EXACT_VERSION.test(distribution.version ?? "")) {
        errors.push(
          `${id}: version "${distribution.version}" is not exact — a range or dist-tag re-resolves at install time`
        )
      }

      if (distribution.provider === "binary") {
        if (!Array.isArray(distribution.artifacts) || distribution.artifacts.length === 0) {
          errors.push(`${id}: a binary distribution needs at least one artifact`)
          continue
        }
        for (const artifact of distribution.artifacts) {
          if (!String(artifact.url ?? "").startsWith("https://")) {
            errors.push(`${id}: artifact ${artifact.platformKey} is not served over https`)
          }
          if (!SHA256.test(artifact.integrity?.sha256 ?? "")) {
            errors.push(`${id}: artifact ${artifact.platformKey} has no SHA-256`)
          }
          if (!artifact.entrypoint) {
            errors.push(`${id}: artifact ${artifact.platformKey} names no entrypoint`)
          }
        }
        continue
      }

      const lock = distribution.lockAsset
      if (!lock?.path) {
        errors.push(`${id}: no approved frozen lock, so this provider must not be offered`)
        continue
      }
      if (!SHA256.test(lock.sha256 ?? "")) {
        errors.push(`${id}: lock asset has no SHA-256, so its bytes can be swapped`)
        continue
      }
      if (!fileExists(join(REPO_ROOT, lock.path))) {
        errors.push(`${id}: lock asset ${lock.path} does not exist`)
        continue
      }
      const actual = sha256(readFile(join(REPO_ROOT, lock.path)))
      if (actual !== lock.sha256) {
        errors.push(
          `${id}: lock asset ${lock.path} hashes to ${actual}, catalog says ${lock.sha256}`
        )
      }
      if (!distribution.entrypoint) {
        errors.push(`${id}: no entrypoint, so the managed install has nothing to launch`)
      }
    }
  }
  return errors
}

export function checkWaivers(catalog) {
  const errors = []
  const waivers = catalog.unpinnedLaunchWaivers?.runtimes
  if (!waivers || typeof waivers !== "object") {
    return [`${CATALOG}: missing unpinnedLaunchWaivers.runtimes`]
  }

  const unpinned = new Set()
  for (const entry of catalog.runtimes) {
    if (entry.systemCommand && isPackageRunner(entry.systemCommand)) {
      unpinned.add(entry.runtimeId)
    }
  }

  for (const runtimeId of unpinned) {
    const reason = waivers[runtimeId]
    if (!reason) {
      errors.push(
        `${runtimeId}: launches through a resolving package runner with no waiver — ` +
          `pin it with an exact version and an approved lock, or record why it is not pinned yet`
      )
    } else if (String(reason).trim().length < 20) {
      errors.push(`${runtimeId}: waiver reason is too short to be a reason`)
    }
  }

  for (const runtimeId of Object.keys(waivers)) {
    if (!unpinned.has(runtimeId)) {
      // The list may only shrink. A stale row hides a hole that was closed.
      errors.push(`${runtimeId}: waived but no longer launches unpinned — remove the waiver`)
    }
  }
  return errors
}

export function checkLaunchParity(catalog, policy) {
  const errors = []
  const binaries = new Set(policy.binaryAllowlist?.commands ?? [])
  const packages = new Set(policy.npxPackageAllowlist?.packages ?? [])

  for (const entry of catalog.runtimes) {
    const command = entry.systemCommand
    if (!command) continue

    if (!isPackageRunner(command)) {
      if (!binaries.has(baseCommand(command))) {
        errors.push(
          `${entry.runtimeId}: launches "${command}", which is not in the security policy's binary allowlist`
        )
      }
      continue
    }

    const target = (entry.launchArgs ?? []).find((arg) => !arg.startsWith("-"))
    if (!target) {
      errors.push(`${entry.runtimeId}: uses a package runner but names no package`)
    } else if (!packages.has(target)) {
      errors.push(
        `${entry.runtimeId}: runs package "${target}", which is not in the security policy's npx allowlist`
      )
    }
  }
  return errors
}

export function checkPlatforms(catalog) {
  const errors = []
  for (const entry of catalog.runtimes) {
    for (const platform of entry.platforms ?? []) {
      if (!KNOWN_PLATFORMS.has(platform)) {
        errors.push(`${entry.runtimeId}: unknown platform "${platform}"`)
      }
    }
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      errors.push(`${entry.runtimeId}: supports no platform at all`)
    }
    if (entry.sandbox?.windowsExceptionEligible && !(entry.platforms ?? []).includes("win32")) {
      errors.push(
        `${entry.runtimeId}: marked eligible for the Windows sandbox exception but does not support win32`
      )
    }
  }
  return errors
}

export function runChecks(
  deps = {
    catalog: readJson(CATALOG),
    policy: readJson(SECURITY_POLICY),
    presetsSource: read(PRESETS_TS),
  }
) {
  const { catalog, policy, presetsSource } = deps
  const schemaErrors = checkSchema(catalog)
  // Later checks read fields the schema check just proved are present, so a
  // schema failure short-circuits rather than producing a cascade of noise.
  if (schemaErrors.length > 0) return schemaErrors

  return [
    ...checkCoverage(catalog, presetsSource),
    ...checkPinning(catalog),
    ...checkWaivers(catalog),
    ...checkLaunchParity(catalog, policy),
    ...checkPlatforms(catalog),
  ]
}

if (process.argv[1]?.endsWith("check-external-agent-runtimes.mjs")) {
  const errors = runChecks()
  if (errors.length > 0) {
    console.error("[external-agent-runtimes] the runtime catalog is not governed:\n")
    for (const error of errors) console.error(`  • ${error}`)
    console.error(
      `\n  ${CATALOG} is the source. Every shipped preset needs an entry, every\n` +
        "  managed distribution needs an exact version plus an approved frozen lock,\n" +
        "  and every remaining unpinned launch needs a waiver with a written reason.\n"
    )
    process.exit(1)
  }
  const catalog = readJson(CATALOG)
  const waived = Object.keys(catalog.unpinnedLaunchWaivers.runtimes).length
  console.log(
    `[external-agent-runtimes] ok — ${catalog.runtimes.length} runtime(s), ` +
      `${catalog.runtimes.flatMap((r) => r.presetIds).length} preset(s), ` +
      `${waived} unpinned launch(es) still waived`
  )
}
