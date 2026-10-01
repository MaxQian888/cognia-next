/**
 * Cogpack archive I/O (ADR-0209): write a signed, deterministic `.cogpack`
 * and read one back with every check applied before anything is trusted.
 *
 * The archive is `manifest.json` plus, for each embedded member, its plugin
 * tree under `plugins/<id>/`. Every embedded file is declared in the manifest
 * with its sha256, so the signature over the manifest covers the files too.
 * Structure, limits and signature checking are the shared package core in
 * `lib/packaging/signed-zip.ts`.
 */

import { sha256Bytes } from "@/lib/ocr/hash"
import { PackageFormatError } from "@/lib/packaging/archive-path"
import { encodeBase64 } from "@/lib/share/encoding"
import {
  assertNoUndeclaredFiles,
  openHardenedZip,
  readDeclaredFile,
  safeArchivePath,
  verifyEd25519PackageSignature,
  writeDeterministicZip,
  type ArchiveEntry,
  type ArchiveLimits,
} from "@/lib/packaging/signed-zip"
import type { TemplatePackageSigner } from "@/lib/templates/package"
import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import type {
  CogpackFileRecord,
  CogpackManifestV1,
  CogpackMember,
} from "@/types/plugin/plugin-cogset"

import {
  COGPACK_LABEL,
  COGPACK_MANIFEST_PATH,
  COGPACK_MAX_PATH_DEPTH,
  cogpackSignaturePayload,
  embeddedRelativePath,
  validateCogpackManifest,
} from "./manifest"

export const COGPACK_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 300 * 1024 * 1024,
  maxFiles: 8192,
  maxCompressionRatio: 200,
  maxPathDepth: COGPACK_MAX_PATH_DEPTH,
}

/** Produces the manifest signature. The publisher identity's signer satisfies it. */
export type CogpackSigner = TemplatePackageSigner

/** One file of an embedded plugin, relative to the plugin's own root. */
export interface EmbeddedPluginFile {
  path: string
  bytes: Uint8Array
}

/** A member as the exporter builds it; embedded sources get their file list here. */
export type CogpackExportMember = Omit<CogpackMember, "source"> & {
  source: Exclude<CogpackMember["source"], { kind: "embedded" }> | { kind: "embedded" }
}

export interface ExportCogpackInput {
  id: string
  version: string
  name: string
  description?: string
  minHostVersion: string
  members: CogpackExportMember[]
  /** Plugin id → its files, for every member whose source is `embedded`. */
  embedded: ReadonlyMap<string, readonly EmbeddedPluginFile[]>
  signer?: CogpackSigner
}

export interface ExportedCogpack {
  bytes: Uint8Array
  /** sha256 of the file. */
  fingerprint: string
  manifest: CogpackManifestV1
}

export interface InspectedCogpack {
  bytes: Uint8Array
  fingerprint: string
  manifest: CogpackManifestV1
  /** Plugin id → relative path → bytes, for every embedded member. */
  embedded: Map<string, Map<string, Uint8Array>>
  /** True when the manifest carried a signature and it verified. */
  signed: boolean
}

export async function exportCogpack(input: ExportCogpackInput): Promise<ExportedCogpack> {
  const entries: ArchiveEntry[] = []
  const members: CogpackMember[] = []

  for (const member of [...input.members].sort((a, b) => a.id.localeCompare(b.id))) {
    if (member.source.kind !== "embedded") {
      members.push(member as CogpackMember)
      continue
    }
    const files = input.embedded.get(member.id)
    if (!files || files.length === 0) {
      throw new PackageFormatError(
        "record-invalid",
        `${COGPACK_LABEL} member ${member.id} is embedded but has no files`
      )
    }
    const root = `plugins/${member.id}`
    const records: CogpackFileRecord[] = []
    const seen = new Set<string>()
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const path = safeArchivePath(`${root}/${file.path}`, COGPACK_MAX_PATH_DEPTH, COGPACK_LABEL)
      if (seen.has(path)) {
        throw new PackageFormatError(
          "duplicate-path",
          `${COGPACK_LABEL} member ${member.id} repeats ${path}`
        )
      }
      seen.add(path)
      records.push({ path, sha256: await sha256Bytes(file.bytes), size: file.bytes.byteLength })
      entries.push({ path, data: file.bytes })
    }
    members.push({ ...member, source: { kind: "embedded", root, files: records } })
  }

  const draft: CogpackManifestV1 = {
    schemaVersion: 1,
    kind: "cognia.cogpack",
    id: input.id,
    version: input.version,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    compatibility: { minHostVersion: input.minHostVersion },
    members,
  }
  // Sign the validated form: it is what the importer reconstructs and
  // verifies, so any normalization must happen before the signature, and an
  // exporter bug fails here rather than on the importer's machine.
  const unsigned = validateCogpackManifest(draft)

  let manifest = unsigned
  if (input.signer) {
    const signature = await input.signer.sign(cogpackSignaturePayload(unsigned))
    manifest = {
      ...unsigned,
      signature: {
        algorithm: "ed25519",
        publisher: input.signer.publisher,
        publicKey: input.signer.publicKey,
        signature: encodeBase64(signature),
      },
    }
    await verifyEd25519PackageSignature(
      manifest.signature!,
      cogpackSignaturePayload(manifest),
      COGPACK_LABEL
    )
  }

  entries.push({ path: COGPACK_MANIFEST_PATH, data: canonicalizeJson(manifest) })
  const bytes = await writeDeterministicZip(entries, COGPACK_LIMITS, COGPACK_LABEL)
  return { bytes, fingerprint: await sha256Bytes(bytes), manifest }
}

export async function inspectCogpack(bytes: Uint8Array): Promise<InspectedCogpack> {
  const archive = await openHardenedZip(bytes, COGPACK_LIMITS, COGPACK_LABEL)
  const manifestFile = archive.zip.file(COGPACK_MANIFEST_PATH)
  if (!manifestFile || manifestFile.dir) {
    throw new PackageFormatError("manifest-missing", `${COGPACK_LABEL} manifest is missing`)
  }
  const manifestText = await manifestFile.async("string")
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    throw new PackageFormatError("manifest-not-json", `${COGPACK_LABEL} manifest is not valid JSON`)
  }
  const manifest = validateCogpackManifest(parsed)
  if (manifest.signature) {
    await verifyEd25519PackageSignature(
      manifest.signature,
      cogpackSignaturePayload(manifest),
      COGPACK_LABEL
    )
  }

  const knownPaths = new Set<string>([COGPACK_MANIFEST_PATH])
  const embedded = new Map<string, Map<string, Uint8Array>>()
  let expanded = new TextEncoder().encode(manifestText).byteLength
  for (const member of manifest.members) {
    if (member.source.kind !== "embedded") continue
    const files = new Map<string, Uint8Array>()
    for (const record of member.source.files) {
      const read = await readDeclaredFile(
        archive,
        record,
        knownPaths,
        COGPACK_LIMITS,
        COGPACK_LABEL,
        "file"
      )
      expanded += read.bytes.byteLength
      files.set(embeddedRelativePath(member.source.root, read.path), read.bytes)
    }
    embedded.set(member.id, files)
  }
  if (expanded > COGPACK_LIMITS.maxExpandedBytes) {
    throw new PackageFormatError(
      "too-large",
      `${COGPACK_LABEL} exceeds ${COGPACK_LIMITS.maxExpandedBytes} expanded bytes`
    )
  }
  assertNoUndeclaredFiles(archive, knownPaths, COGPACK_LABEL)

  return {
    bytes,
    fingerprint: await sha256Bytes(bytes),
    manifest,
    embedded,
    signed: !!manifest.signature,
  }
}
