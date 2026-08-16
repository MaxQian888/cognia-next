/**
 * Locate and verify the bundled Cognia Pi extension (ADR-0119).
 *
 * The extension is what enforces Pi's native-tool permission matrix, so two
 * things have to be true before a session may start: the file must be found,
 * and it must be the file Cognia shipped. A tampered or substituted extension
 * would silently hold the permission gate open, and the handshake alone cannot
 * detect that — a modified extension can still announce itself.
 *
 * Resolution mirrors `resolveToolBridgeScript` so both packaged artifacts are
 * discovered the same way:
 *   1. `$COGNIA_PI_EXTENSION_PATH` (explicit override)
 *   2. a `sidecar/` dir next to the executable (packaged dist layout)
 *   3. a `sidecar/` dir walked up from this module (in-repo / dev)
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const EXTENSION_RELATIVE = path.join("sidecar", "pi-extension", "cognia-pi-extension.ts")
const INTEGRITY_RELATIVE = path.join("sidecar", "pi-extension", "integrity.json")

export interface ResolvePiExtensionOptions {
  env?: NodeJS.ProcessEnv
  exists?: (candidate: string) => boolean
  execPath?: string
}

/**
 * Is `$COGNIA_PI_EXTENSION_PATH` allowed to redirect the resolver?
 *
 * Only outside production. The override exists so a contributor can iterate on
 * the extension without re-pinning after every edit; in a shipped build it is
 * an env var that swaps out the component holding the permission gate, which
 * is precisely the substitution the digest pin exists to prevent.
 */
export function piExtensionOverrideAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production"
}

/** Absolute path of the bundled extension, or undefined when it is absent. */
export function resolvePiExtensionScript(opts: ResolvePiExtensionOptions = {}): string | undefined {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? fs.existsSync
  const execPath = opts.execPath ?? process.execPath

  const override = env.COGNIA_PI_EXTENSION_PATH?.trim()
  // An explicit override is returned even when it does not exist, so a typo
  // surfaces as "the file you pointed at is missing" rather than silently
  // falling back to a different extension than the operator intended.
  if (override && piExtensionOverrideAllowed(env)) return override

  const adjacent = path.join(path.dirname(execPath), EXTENSION_RELATIVE)
  if (exists(adjacent)) return adjacent

  let dir: string
  try {
    dir = path.dirname(fileURLToPath(import.meta.url))
  } catch {
    dir = typeof __dirname === "string" ? __dirname : process.cwd()
  }
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, EXTENSION_RELATIVE)
    if (exists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** SHA-256 of a file's bytes, lowercase hex. */
export function digestFile(file: string, read: (p: string) => Buffer = fs.readFileSync): string {
  return createHash("sha256").update(read(file)).digest("hex")
}

export interface PiExtensionIntegrity {
  /** Expected SHA-256 of `cognia-pi-extension.ts`. */
  sha256: string
}

export type PiExtensionVerdict =
  | { status: "ok"; path: string; sha256: string }
  | { status: "missing" }
  | { status: "unreadable"; path: string; detail: string }
  /** Found, but not the file Cognia shipped. */
  | { status: "tampered"; path: string; expected: string; actual: string }
  /** Found, but no pinned digest to compare against. */
  | { status: "unpinned"; path: string; sha256: string }

export interface VerifyPiExtensionOptions extends ResolvePiExtensionOptions {
  readFile?: (p: string) => Buffer
  readIntegrity?: (p: string) => string
}

/**
 * Resolve the extension and check it against its pinned digest.
 *
 * `unpinned` is reported rather than treated as success: shipping without the
 * manifest is a packaging mistake, and silently accepting any file there would
 * make the pin decorative.
 */
export function verifyPiExtension(opts: VerifyPiExtensionOptions = {}): PiExtensionVerdict {
  const resolved = resolvePiExtensionScript(opts)
  if (!resolved) return { status: "missing" }

  const readFile = opts.readFile ?? fs.readFileSync
  const readIntegrity = opts.readIntegrity ?? ((p: string) => fs.readFileSync(p, "utf8"))

  let actual: string
  try {
    actual = digestFile(resolved, readFile)
  } catch (error) {
    return { status: "unreadable", path: resolved, detail: String(error) }
  }

  const manifestPath = path.join(
    resolved.slice(0, resolved.length - EXTENSION_RELATIVE.length),
    INTEGRITY_RELATIVE
  )

  let expected: string | undefined
  try {
    const parsed = JSON.parse(readIntegrity(manifestPath)) as Partial<PiExtensionIntegrity>
    expected = typeof parsed.sha256 === "string" ? parsed.sha256.toLowerCase() : undefined
  } catch {
    expected = undefined
  }

  if (!expected) return { status: "unpinned", path: resolved, sha256: actual }
  if (expected !== actual) return { status: "tampered", path: resolved, expected, actual }
  return { status: "ok", path: resolved, sha256: actual }
}

/**
 * The path to hand the Pi adapter, or undefined when the extension must not be
 * loaded.
 *
 * **Only `ok` yields a path.** `unpinned` used to be accepted too, which made
 * the pin decorative: an extension shipped without its manifest — or with the
 * manifest stripped — loaded anyway and took charge of the permission gate.
 * "We could not verify this" and "this is verified" must not lead to the same
 * place when the component being verified is the thing enforcing permissions.
 *
 * A refusal is not a downgrade to "run without the extension": the caller
 * treats a missing path as a refused session (`PI_EXTENSION_REQUIRED`),
 * because without interception Pi's native tools run with the full rights of
 * the process.
 */
export function piExtensionPathForSpawn(verdict: PiExtensionVerdict): string | undefined {
  return verdict.status === "ok" ? verdict.path : undefined
}

/**
 * Why a session may not start, phrased for the user, or `undefined` when the
 * extension verified clean.
 */
export function piExtensionRefusalReason(verdict: PiExtensionVerdict): string | undefined {
  switch (verdict.status) {
    case "ok":
      return undefined
    case "missing":
      return "The bundled Cognia Pi extension was not found. Reinstall Cognia — without it Pi's native tools would run unintercepted."
    case "unreadable":
      return `The bundled Cognia Pi extension at ${verdict.path} could not be read: ${verdict.detail}`
    case "tampered":
      return `The bundled Cognia Pi extension at ${verdict.path} does not match its pinned digest (expected ${verdict.expected}, found ${verdict.actual}). Reinstall Cognia.`
    case "unpinned":
      return `The bundled Cognia Pi extension at ${verdict.path} has no integrity manifest, so it cannot be verified. Reinstall Cognia.`
  }
}
