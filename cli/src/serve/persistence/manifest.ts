/**
 * The backend manifest — the one file that decides which durability backend an
 * account boots on.
 *
 * Written atomically (staging file → `fsync` → rename → directory `fsync`) so a
 * crash mid-switch always leaves either the old manifest or the new one, never
 * a truncated pointer that would boot the brain against nothing.
 *
 * `rollbackWatermark` is the oldest generation the tooling promises is still
 * intact. `durability finalize` is the only operation that may raise it, and
 * only after the operator confirms — every other operation adds generations.
 */
import fs from "node:fs"
import path from "node:path"

import { canonicalJson } from "./canonical"
import { DurabilityFault, isDurabilityBackendId, type DurabilityBackendId } from "./types"

export const MANIFEST_FORMAT = 1 as const

export interface BackendManifest {
  manifestFormat: typeof MANIFEST_FORMAT
  /** Backend the brain reads and writes on boot. */
  activeBackend: DurabilityBackendId
  /**
   * Backend that is being populated alongside `activeBackend`.
   *
   * Non-null exactly during a compatibility window: the journal is appended
   * first and the same sequence is applied to the shadow second. Cleared by
   * `durability migrate` once parity verification passes and the shadow is
   * promoted, or by `durability rollback`.
   */
  shadowBackend: DurabilityBackendId | null
  /** Oldest generation the tooling guarantees is still on disk. */
  rollbackWatermark: string | null
  updatedAt: number
}

export function manifestFile(root: string): string {
  return path.join(root, "backend-manifest.json")
}

export function defaultManifest(): BackendManifest {
  return {
    manifestFormat: MANIFEST_FORMAT,
    activeBackend: "journal-v4",
    shadowBackend: null,
    rollbackWatermark: null,
    updatedAt: 0,
  }
}

export function parseManifest(text: string): BackendManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DurabilityFault("manifest-corrupt", "backend manifest is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DurabilityFault("manifest-corrupt", "backend manifest is not an object")
  }
  const root = parsed as Record<string, unknown>
  if (root.manifestFormat !== MANIFEST_FORMAT) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `unsupported backend manifest format ${String(root.manifestFormat)}`
    )
  }
  if (!isDurabilityBackendId(root.activeBackend)) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `backend manifest names an unknown active backend ${String(root.activeBackend)}`
    )
  }
  const shadow = root.shadowBackend
  if (shadow !== null && shadow !== undefined && !isDurabilityBackendId(shadow)) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `backend manifest names an unknown shadow backend ${String(shadow)}`
    )
  }
  return {
    manifestFormat: MANIFEST_FORMAT,
    activeBackend: root.activeBackend,
    shadowBackend: isDurabilityBackendId(shadow) ? shadow : null,
    rollbackWatermark: typeof root.rollbackWatermark === "string" ? root.rollbackWatermark : null,
    updatedAt: typeof root.updatedAt === "number" ? root.updatedAt : 0,
  }
}

/** Read the manifest, or the default when the account has never been migrated. */
export function readManifest(root: string): BackendManifest {
  const file = manifestFile(root)
  if (!fs.existsSync(file)) return defaultManifest()
  return parseManifest(fs.readFileSync(file, "utf8"))
}

export function writeManifest(root: string, manifest: BackendManifest, now = Date.now): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = manifestFile(root)
  const staging = `${file}.staging`
  const payload = canonicalJson({ ...manifest, updatedAt: now() })
  const descriptor = fs.openSync(staging, "w", 0o600)
  try {
    fs.writeFileSync(descriptor, payload, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(staging, file)
  if (process.platform !== "win32") {
    const dir = fs.openSync(root, "r")
    try {
      fs.fsyncSync(dir)
    } finally {
      fs.closeSync(dir)
    }
  }
}
