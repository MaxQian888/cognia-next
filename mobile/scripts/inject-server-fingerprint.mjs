#!/usr/bin/env node
/**
 * inject-server-fingerprint.mjs — rewrite the production
 * NetworkSecurityConfig with a `<pin-set>` block for the
 * paired-desktop's TLS SPKI fingerprint.
 *
 * Run before a release `npx cap sync android` so the resulting APK
 * pins to a single, known-good cert at the OS layer.
 *
 * Sources, in priority order:
 *   1. `--fingerprint <hex>` CLI flag.
 *   2. `COGNIA_PIN_FINGERPRINT` env var.
 *   3. `~/.cognia/companion-fingerprint.txt` (text file written by the
 *      desktop on first cert generation).
 *
 * Behaviour:
 *   - If no fingerprint source resolves, the script leaves the file
 *     untouched and exits 0 — debug builds and first-time release
 *     builds are not blocked.
 *   - If the marker `INJECT_PIN_SET` is missing (file already injected
 *     or hand-edited), exits with a warning but not a non-zero code so
 *     CI doesn't break on idempotent re-runs.
 *   - The script is intentionally pure: it never touches the filesystem
 *     outside the project root and the user's `~/.cognia` dir.
 *
 * The companion test suite drives this same module via
 * `inject-server-fingerprint.test.mjs` using `node --test`.
 */

import { readFile, writeFile, access } from "node:fs/promises"
import { constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { argv, env, exit } from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..")
const NSC_PATH = resolve(
  PROJECT_ROOT,
  "android",
  "app",
  "src",
  "main",
  "res",
  "xml",
  "network_security_config.xml"
)
const MARKER = "INJECT_PIN_SET"

/**
 * Resolve the fingerprint from CLI > env > user file. Returns `null`
 * when none is available (caller short-circuits to a no-op).
 */
export async function resolveFingerprint(
  args = argv.slice(2),
  environment = env,
  homeDir = homedir()
) {
  const flagIdx = args.findIndex((a) => a === "--fingerprint")
  if (flagIdx >= 0 && args[flagIdx + 1]) {
    return normaliseFingerprint(args[flagIdx + 1])
  }
  if (environment.COGNIA_PIN_FINGERPRINT) {
    return normaliseFingerprint(environment.COGNIA_PIN_FINGERPRINT)
  }
  const fileCandidate = resolve(homeDir, ".cognia", "companion-fingerprint.txt")
  try {
    await access(fileCandidate, constants.R_OK)
    const raw = await readFile(fileCandidate, "utf8")
    return normaliseFingerprint(raw)
  } catch {
    return null
  }
}

/**
 * Strip whitespace + non-hex separators (colons, dashes) from a
 * fingerprint string and return the canonical lower-case hex. Returns
 * `null` if the cleaned value isn't a SHA-256 (32 byte) digest.
 */
export function normaliseFingerprint(raw) {
  if (typeof raw !== "string") return null
  const cleaned = raw
    .trim()
    .replace(/[\s:-]/g, "")
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(cleaned)) return null
  return cleaned
}

/**
 * Format a hex fingerprint into the pin-set entry digest the Android
 * NSC expects: SHA-256 base64. Caller supplies a `b64encoder` (the
 * Node Buffer API by default) so tests can inject deterministic
 * encodings.
 */
export function fingerprintToPinDigest(hex, b64encoder = bufferToBase64) {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("fingerprint must be lower-case SHA-256 hex")
  }
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return b64encoder(bytes)
}

function bufferToBase64(bytes) {
  return Buffer.from(bytes).toString("base64")
}

const PIN_SET_MARKER_RE = /<!--\s*INJECT_PIN_SET[\s\S]*?(?:-->|$)/m

/**
 * Replace the `INJECT_PIN_SET` marker comment with a real `<pin-set>`
 * element. Returns the rewritten XML — the file write happens in
 * [`main`] so this helper stays pure for unit tests.
 */
export function rewritePinSet(xml, digestB64) {
  if (!xml.includes(MARKER)) {
    return { changed: false, xml }
  }
  const pinSet = [
    '<pin-set expiration="2030-01-01">',
    `            <pin digest=\"SHA-256\">${digestB64}</pin>`,
    "        </pin-set>",
  ].join("\n        ")
  const rewritten = xml.replace(PIN_SET_MARKER_RE, pinSet)
  return { changed: rewritten !== xml, xml: rewritten }
}

export async function main(deps = {}) {
  const {
    resolveFn = resolveFingerprint,
    readFn = readFile,
    writeFn = writeFile,
    targetPath = NSC_PATH,
    logger = console,
  } = deps

  const fingerprint = await resolveFn()
  if (!fingerprint) {
    logger.log("[inject-server-fingerprint] no fingerprint source — leaving NSC untouched")
    return { kind: "skipped", reason: "no-fingerprint" }
  }

  let xml
  try {
    xml = await readFn(targetPath, "utf8")
  } catch (err) {
    logger.warn(`[inject-server-fingerprint] NSC not readable at ${targetPath}: ${err.message}`)
    return { kind: "skipped", reason: "missing-nsc" }
  }

  const digest = fingerprintToPinDigest(fingerprint)
  const { changed, xml: rewritten } = rewritePinSet(xml, digest)
  if (!changed) {
    logger.warn("[inject-server-fingerprint] INJECT_PIN_SET marker missing — already injected?")
    return { kind: "skipped", reason: "marker-missing" }
  }

  await writeFn(targetPath, rewritten, "utf8")
  logger.log(`[inject-server-fingerprint] pinned ${digest.slice(0, 8)}… into ${targetPath}`)
  return { kind: "injected", digest }
}

// CLI entry point — skipped when imported by the test harness.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`
) {
  main().catch((err) => {
    console.error("[inject-server-fingerprint] fatal:", err)
    exit(1)
  })
}
