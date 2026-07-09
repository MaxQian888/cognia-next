#!/usr/bin/env node
/**
 * Single-source config-constant sync — sibling of version-sync.mjs for
 * cross-language constants that are hand-mirrored between Rust and TS.
 *
 * Each CONFIGS entry names ONE canonical source (a file + regex whose first
 * capture group is the value) and N mirrors. Default mode rewrites drifted
 * mirrors from the canonical value; `--check` exits 1 listing the drift
 * without writing (CI mode). A regex that stops matching is a HARD error in
 * both modes — that is the gate actually catching a refactor, not a soft
 * skip.
 *
 * Mirrors marked `checkOnly: true` are verified but never rewritten (e.g. the
 * head of lan-scanner's PROBE_PORTS list, whose legacy tail entries are
 * intentional back-compat).
 *
 * Currently synced:
 *   - companion default port: canonical in Rust
 *     (`companion_api::server::DEFAULT_PORT`), mirrored in the settings UI
 *     and both LAN connectivity modules.
 *
 * Usage:
 *   node scripts/sync/config-sync.mjs           # rewrite drifted mirrors
 *   node scripts/sync/config-sync.mjs --check   # verify only (CI)
 */

import { readFileSync, writeFileSync, realpathSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")

export const CONFIGS = [
  {
    name: "companion default port",
    canonical: {
      path: "src-tauri/src/companion_api/server.rs",
      re: /pub const DEFAULT_PORT: u16 = (\d+);/,
    },
    mirrors: [
      {
        path: "components/settings/companion/companion-section.tsx",
        re: /const DEFAULT_PORT = (\d+)/,
      },
      {
        path: "lib/connectivity/lan-scanner.ts",
        re: /const DEFAULT_PORT = (\d+)/,
      },
      {
        // Primary probe port must equal the canonical port. Never rewritten:
        // the tail (7890, …) is intentional legacy-rediscovery back-compat.
        path: "lib/connectivity/lan-scanner.ts",
        re: /PROBE_PORTS: readonly number\[\] = \[(\d+),/,
        checkOnly: true,
      },
      {
        path: "lib/connectivity/lan-resolver.ts",
        re: /const DEFAULT_PORT = (\d+)/,
      },
    ],
  },
]

/** First capture group of `re` in `content`, or null when the regex no longer matches. */
export function extractValue(content, re) {
  const m = content.match(re)
  return m ? m[1] : null
}

/** Splice `value` into the capture-group-1 span of `re`'s match in `content`. */
export function replaceValue(content, re, value) {
  const m = content.match(re)
  if (!m || m.index === undefined) {
    throw new Error(`replaceValue: pattern ${re} no longer matches`)
  }
  const groupOffset = m[0].indexOf(m[1])
  const start = m.index + groupOffset
  return content.slice(0, start) + value + content.slice(start + m[1].length)
}

/**
 * Pure check pass. `readFn(relPath) -> string` is injectable for tests.
 * Returns { drifted, missing } — `missing` entries are regexes that stopped
 * matching (hard error), `drifted` are mirrors whose value ≠ canonical.
 */
export function checkConfigs(readFn) {
  const drifted = []
  const missing = []
  for (const config of CONFIGS) {
    const canonicalContent = readFn(config.canonical.path)
    const canonical = extractValue(canonicalContent, config.canonical.re)
    if (canonical === null) {
      missing.push({ config: config.name, path: config.canonical.path, canonical: true })
      continue
    }
    for (const mirror of config.mirrors) {
      const value = extractValue(readFn(mirror.path), mirror.re)
      if (value === null) {
        missing.push({ config: config.name, path: mirror.path, canonical: false })
      } else if (value !== canonical) {
        drifted.push({
          config: config.name,
          path: mirror.path,
          current: value,
          expected: canonical,
          checkOnly: Boolean(mirror.checkOnly),
        })
      }
    }
  }
  return { drifted, missing }
}

function main() {
  const checkMode = process.argv.includes("--check")
  const readFn = (rel) => readFileSync(resolve(REPO_ROOT, rel), "utf8")
  const { drifted, missing } = checkConfigs(readFn)

  if (missing.length > 0) {
    console.error(
      "[config-sync] FAIL — pattern(s) no longer match (refactor broke the sync table):"
    )
    for (const m of missing) {
      console.error(`  ${m.path} (${m.config}${m.canonical ? ", canonical source" : ""})`)
    }
    return 1
  }

  if (drifted.length === 0) {
    console.log(
      `[config-sync] OK — ${CONFIGS.length} config(s), all mirrors match their canonical source.`
    )
    return 0
  }

  if (checkMode) {
    console.error(`[config-sync] FAIL — ${drifted.length} drifted mirror(s):`)
    for (const d of drifted) {
      console.error(`  ${d.path}  (${d.config}: ${d.current} → ${d.expected})`)
    }
    console.error("  Run `pnpm config:sync` to rewrite, or fix the canonical source.")
    return 1
  }

  let rewritten = 0
  for (const config of CONFIGS) {
    const canonical = extractValue(readFn(config.canonical.path), config.canonical.re)
    for (const mirror of config.mirrors) {
      const abs = resolve(REPO_ROOT, mirror.path)
      const content = readFileSync(abs, "utf8")
      const value = extractValue(content, mirror.re)
      if (value === null || value === canonical) continue
      if (mirror.checkOnly) {
        console.error(
          `[config-sync] ${mirror.path} drifted (${value} → ${canonical}) but is check-only — fix by hand.`
        )
        continue
      }
      writeFileSync(abs, replaceValue(content, mirror.re, canonical))
      console.log(`[config-sync] rewrote ${mirror.path}: ${value} → ${canonical}`)
      rewritten += 1
    }
  }
  const checkOnlyDrift = drifted.filter((d) => d.checkOnly)
  if (checkOnlyDrift.length > 0) return 1
  console.log(`[config-sync] done — ${rewritten} mirror(s) rewritten.`)
  return 0
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isDirectRun) {
  process.exit(main())
}
