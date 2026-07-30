#!/usr/bin/env node
/**
 * Generate the non-TypeScript halves of the settings sync contract from
 * `packages/agent-config-types/src/settings-sync.ts`.
 *
 * That table is the source of truth for which `AppSettings` fields cross the
 * wire and in which direction. Two consumers cannot import it directly, so they
 * are generated here and gated with `--check`:
 *
 *   1. `src-tauri/src/companion_api/settings_sync_generated.rs` — the server-side
 *      write allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS`) that
 *      `app_settings_update` enforces.
 *   2. `docs/api/mobile-companion-api.openapi.yaml` — the `propertyNames.enum`
 *      on the `app_settings_update` patch body, so the published wire contract
 *      names the same keys the server accepts.
 *
 * Before this existed the Rust constant and the TypeScript mirror were both
 * hand-maintained and had silently drifted: ~51 fields were writable up but
 * never mirrored down, the WebRTC/signaling fields were classified in the wrong
 * direction, and one entry (`defaultCharacterId`) named a field that lives on
 * `AdapterInstanceRow`, not on `AppSettings`.
 *
 * Usage:
 *   node scripts/build/gen-settings-sync.mjs          # write the artifacts
 *   node scripts/build/gen-settings-sync.mjs --check  # fail if they drifted
 */

import { readFileSync, writeFileSync } from "node:fs"
import { transform } from "esbuild"

const TABLE_SOURCE = "packages/agent-config-types/src/settings-sync.ts"
const RUST_TARGET = "src-tauri/src/companion_api/settings_sync_generated.rs"
const OPENAPI_TARGET = "docs/api/mobile-companion-api.openapi.yaml"

const OPENAPI_BEGIN = "# BEGIN GENERATED settings-sync"
const OPENAPI_END = "# END GENERATED settings-sync"

/**
 * Load the classification table. The file's only import is `import type`, so
 * esbuild erases it and the module evaluates standalone — no tsc, no bundling
 * of the 188 KB type hub it nominally depends on.
 *
 * @param {string} source raw TypeScript
 * @returns {Promise<Record<string, { category: string, rationale?: string }>>}
 */
export async function loadTable(source) {
  const { code } = await transform(source, { loader: "ts", format: "esm" })
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`
  )
  return mod.SETTINGS_SYNC
}

/**
 * Split the table into the three buckets the generated artifacts care about.
 * Keys are sorted so the output is stable regardless of declaration order.
 *
 * @param {Record<string, { category: string, rationale?: string }>} table
 */
export function bucketize(table) {
  /** @type {string[]} */ const shared = []
  /** @type {Array<[string, string]>} */ const serverAuthoritative = []
  /** @type {Array<[string, string]>} */ const deviceLocal = []
  for (const key of Object.keys(table).sort()) {
    const entry = table[key]
    if (entry.category === "shared") shared.push(key)
    else if (entry.category === "server-authoritative")
      serverAuthoritative.push([key, entry.rationale])
    else if (entry.category === "device-local") deviceLocal.push([key, entry.rationale])
  }
  return { shared, serverAuthoritative, deviceLocal }
}

/**
 * Wrap prose to `//!`- or `//`-prefixed Rust comment lines.
 *
 * @param {string} text
 * @param {string} prefix
 */
function rustComment(text, prefix) {
  const words = text.split(/\s+/)
  /** @type {string[]} */ const lines = []
  let cur = ""
  for (const word of words) {
    if (cur && `${prefix}${cur} ${word}`.length > 96) {
      lines.push(prefix + cur)
      cur = word
    } else {
      cur = cur ? `${cur} ${word}` : word
    }
  }
  if (cur) lines.push(prefix + cur)
  return lines.join("\n")
}

/** @param {ReturnType<typeof bucketize>} buckets */
export function renderRust({ shared, serverAuthoritative, deviceLocal }) {
  const excluded = [
    ...serverAuthoritative.map(
      ([key, rationale]) =>
        `${rustComment(`\`${key}\` — server-authoritative (mirrored down, never accepted up).`, "//! ")}\n${rustComment(rationale, "//!   ")}`
    ),
    ...deviceLocal.map(
      ([key, rationale]) =>
        `${rustComment(`\`${key}\` — device-local (never crosses the wire).`, "//! ")}\n${rustComment(rationale, "//!   ")}`
    ),
  ].join("\n//!\n")

  return `//! GENERATED FILE — DO NOT EDIT.
//!
//! Source: \`${TABLE_SOURCE}\`
//! Generator: \`scripts/build/gen-settings-sync.mjs\` (CI runs it with \`--check\`)
//!
//! The allowlist below is every \`AppSettings\` field classified \`shared\`: a
//! paired client may write it to its host through \`app_settings_update\`, and
//! the host mirrors it back down through \`sync_pull\`. Everything else is
//! rejected with \`400 validation_failed\`.
//!
//! Fields deliberately excluded, and why — so a reader who expects one here
//! finds the reason instead of assuming an oversight:
//!
${excluded}
//!
//! Every other \`AppSettings\` field is \`desktop-only\`: credentials, filesystem
//! paths, desktop-only subsystems, and internal bookkeeping that are not part
//! of the mobile contract at all.

/// Allowlisted patch keys for \`app_settings_update\`.
pub const APP_SETTINGS_MOBILE_ALLOWED_KEYS: &[&str] = &[
${shared.map((key) => `    "${key}",`).join("\n")}
];

#[cfg(test)]
mod tests {
    use super::APP_SETTINGS_MOBILE_ALLOWED_KEYS;

    /// The \`--check\` gate proves this file matches the table it came from.
    /// These prove the shape the RPC handler relies on, which no amount of
    /// regeneration guarantees on its own.
    #[test]
    fn the_allowlist_is_usable_as_a_lookup() {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.is_empty(),
            "an empty allowlist would reject every mobile settings write"
        );
        let mut seen = std::collections::BTreeSet::new();
        for key in APP_SETTINGS_MOBILE_ALLOWED_KEYS {
            assert!(!key.trim().is_empty(), "a blank key would match nothing");
            assert!(seen.insert(*key), "duplicate allowlist entry: {key}");
        }
        let sorted: Vec<&str> = seen.iter().copied().collect();
        assert_eq!(
            sorted.as_slice(),
            APP_SETTINGS_MOBILE_ALLOWED_KEYS,
            "the generator emits sorted keys; an unsorted list means a hand edit"
        );
    }

    /// Server-authoritative and device-local fields flow the other way, or not
    /// at all. Accepting one here is the leak the classification table exists
    /// to prevent, so it is asserted rather than left to review.
    #[test]
    fn nothing_that_must_not_travel_upward_is_allowlisted() {
        for forbidden in [
            "iceServers",
            "turnServers",
            "turnProvider",
            "signalingUrl",
            "remoteBrowserEnabled",
            "biometricRequiredFor",
            "workflowEditorPerformanceTier",
            "selectedMicId",
            "apiKey",
        ] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&forbidden),
                "{forbidden} must not be writable from a paired client"
            );
        }
    }
}
`
}

/**
 * Replace the generated region of the OpenAPI spec in place. The markers are
 * committed by hand once; everything between them is owned by this generator.
 *
 * @param {string} spec
 * @param {string[]} shared
 */
export function renderOpenApi(spec, shared) {
  const lines = spec.split("\n")
  const beginIdx = lines.findIndex((line) => line.trim() === OPENAPI_BEGIN)
  const endIdx = lines.findIndex((line) => line.trim() === OPENAPI_END)
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(
      `${OPENAPI_TARGET}: missing or malformed "${OPENAPI_BEGIN}" / "${OPENAPI_END}" markers`
    )
  }
  const indent = lines[beginIdx].slice(0, lines[beginIdx].indexOf("#"))
  const body = [`${indent}enum:`, ...shared.map((key) => `${indent}  - ${key}`)]
  return [...lines.slice(0, beginIdx + 1), ...body, ...lines.slice(endIdx)].join("\n")
}

/**
 * @param {{ check?: boolean, read?: (p: string) => string, write?: (p: string, c: string) => void }} [deps]
 * @returns {Promise<string[]>} errors (empty when in sync)
 */
export async function genSettingsSync(deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"))
  const write = deps.write ?? ((p, c) => writeFileSync(p, c))
  const check = deps.check ?? false

  const buckets = bucketize(await loadTable(read(TABLE_SOURCE)))
  const artifacts = [
    { path: RUST_TARGET, next: renderRust(buckets) },
    { path: OPENAPI_TARGET, next: renderOpenApi(read(OPENAPI_TARGET), buckets.shared) },
  ]

  /** @type {string[]} */ const errors = []
  for (const { path, next } of artifacts) {
    let current
    try {
      current = read(path)
    } catch {
      current = null
    }
    if (current === next) continue
    if (check) {
      errors.push(
        current === null
          ? `${path}: missing — run \`pnpm settings-sync:gen\``
          : `${path}: out of sync with ${TABLE_SOURCE} — run \`pnpm settings-sync:gen\``
      )
    } else {
      write(path, next)
      console.log(`[gen-settings-sync] wrote ${path}`)
    }
  }
  return errors
}

const isEntry = process.argv[1]?.endsWith("gen-settings-sync.mjs")
if (isEntry) {
  const errors = await genSettingsSync({ check: process.argv.includes("--check") })
  if (errors.length > 0) {
    console.error("[gen-settings-sync] generated artifacts drifted from the source table:")
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }
  console.log("[gen-settings-sync] OK")
}
