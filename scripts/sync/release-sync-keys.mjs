#!/usr/bin/env node
/**
 * Sync the Ed25519 release-signing public key from its source of truth
 * (`crates/cognia-cli/src/engine/release_key.rs`) into the two mirrors:
 *   - src-tauri/src/cli_bridge/release_key.rs
 *   - lib/cli-bridge/embedded-pubkey.ts
 *
 * The key value lives in exactly one place. This script reads it from the
 * canonical Rust constant and rewrites the `…_BASE64` literal in each
 * mirror so they can never drift. Run after rotating the key (which is
 * done out-of-band on the release runner — the private half never enters
 * the repo).
 *
 * Usage:  node scripts/release-sync-keys.mjs           (sync)
 *         node scripts/release-sync-keys.mjs --check    (CI: fail on drift)
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

// The cognia-cli crate was reorganized into commands/ engine/ shared/ ui/;
// this path followed the key constant into engine/. `commands/release_key.rs`
// only consumes it. The stale path went unnoticed because this gate lived in
// `check:all` but had never run in CI — it crashed with ENOENT the first time
// the registry actually invoked it.
const SOURCE = join(root, "crates/cognia-cli/src/engine/release_key.rs")
const RUST_MIRROR = join(root, "src-tauri/src/cli_bridge/release_key.rs")
const TS_MIRROR = join(root, "lib/cli-bridge/embedded-pubkey.ts")

const KEY_RE = /RELEASE_PUBLIC_KEY_BASE64[^"]*"([A-Za-z0-9+/=]+)"/
const TS_KEY_RE = /EMBEDDED_COGNIA_RELEASE_PUBKEY\s*=\s*\n?\s*"([A-Za-z0-9+/=]+)"/
const TS_FINGERPRINT_RE =
  /(EMBEDDED_COGNIA_RELEASE_KEY_FINGERPRINT_SHA256\s*=\s*\n?\s*")[a-f0-9]{64}(")/

function readCanonicalKey() {
  const src = readFileSync(SOURCE, "utf8")
  const m = src.match(KEY_RE)
  if (!m) {
    console.error(`[release-sync-keys] could not find key in ${SOURCE}`)
    process.exit(1)
  }
  return m[1]
}

function syncRustMirror(key, check) {
  const content = readFileSync(RUST_MIRROR, "utf8")
  const next = content.replace(
    /(RELEASE_PUBLIC_KEY_BASE64: &str = ")[A-Za-z0-9+/=]+(")/,
    `$1${key}$2`
  )
  // Also keep the placeholder-comparison literal in sync.
  const next2 = next.replace(
    /(is_placeholder_key.*\n.*== ")[A-Za-z0-9+/=]+(")/,
    `$1${key === PLACEHOLDER ? PLACEHOLDER : PLACEHOLDER}$2`
  )
  return maybeWrite(RUST_MIRROR, content, next2, check)
}

function syncTsMirror(key, check) {
  const content = readFileSync(TS_MIRROR, "utf8")
  const fingerprint = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")
  const next = content.replace(
    /(EMBEDDED_COGNIA_RELEASE_PUBKEY\s*=\s*\n?\s*")[A-Za-z0-9+/=]+(")/,
    `$1${key}$2`
  )
  const nextWithFingerprint = next.replace(TS_FINGERPRINT_RE, `$1${fingerprint}$2`)
  return maybeWrite(TS_MIRROR, content, nextWithFingerprint, check)
}

const PLACEHOLDER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

function maybeWrite(path, before, after, check) {
  if (before === after) return true
  if (check) {
    console.error(`[release-sync-keys] DRIFT: ${path} is out of sync`)
    return false
  }
  writeFileSync(path, after)
  console.log(`[release-sync-keys] updated ${path}`)
  return true
}

function main() {
  const check = process.argv.includes("--check")
  const key = readCanonicalKey()
  // Validate the TS mirror parse target exists.
  const tsContent = readFileSync(TS_MIRROR, "utf8")
  if (!TS_KEY_RE.test(tsContent)) {
    console.error(`[release-sync-keys] could not find key literal in ${TS_MIRROR}`)
    process.exit(1)
  }
  if (!TS_FINGERPRINT_RE.test(tsContent)) {
    console.error(`[release-sync-keys] could not find fingerprint literal in ${TS_MIRROR}`)
    process.exit(1)
  }
  const ok = [syncRustMirror(key, check), syncTsMirror(key, check)].every(Boolean)
  if (check && !ok) {
    console.error("[release-sync-keys] run `node scripts/release-sync-keys.mjs` to fix")
    process.exit(1)
  }
  if (!check) console.log("[release-sync-keys] mirrors in sync")
}

main()
