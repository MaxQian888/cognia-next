/**
 * The rows behind a FileSpace's Dexie-backed mounts (ADR-0222 §1):
 * `/uploads` projects the session's assets, `/artifacts` its artifacts.
 *
 * Both read metadata only — asset bytes stay unloaded (`listSessionAssets`
 * never materializes a source) and artifact bodies are only measured.
 *
 * # Naming
 *
 * A Dexie row has a title, not a path, and two uploads can share a filename.
 * A link must keep resolving, so names are assigned like this:
 *
 * - a name unique within its mount is used as-is: `/uploads/report.pdf`;
 * - every row of a colliding name is addressed as `stem~<id8>.ext`, which is
 *   what listings and copied links show;
 * - lookup accepts both: the `~<id8>` form always resolves to its row, and a
 *   bare name that has since become ambiguous resolves to the OLDEST row of
 *   that name — the one a link copied while it was still unique pointed at.
 */

import { getArtifactExtension } from "@/lib/artifacts/constants"
import { getDb } from "@/lib/db/schema"
import type { ArtifactRow } from "@/lib/db/artifact-types"
import { listSessionAssets, type ListedSessionAsset } from "@/lib/db/session-assets"
import type { FileSpaceDexieEntry, FileSpacePath } from "@/types/filespace"

import { joinFileSpacePath } from "./paths"
import { ARTIFACTS_MOUNT_PATH, UPLOADS_MOUNT_PATH } from "./resolve"

/** Characters a FileSpace segment cannot carry, plus what file systems refuse. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g

/** Length of the id suffix that disambiguates colliding names. */
export const DISAMBIGUATION_ID_LENGTH = 8

/** A display name turned into one valid, non-empty path segment. */
export function fileSpaceSegmentName(raw: string, fallback: string): string {
  const cleaned = raw.normalize("NFC").replace(UNSAFE_NAME_CHARS, " ").replace(/\s+/g, " ").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return cleaned
}

interface NamedRow {
  sourceId: string
  name: string
  createdAt: number
}

/** `stem~<id8>.ext`, keeping a dotfile's leading dot in the stem. */
export function disambiguatedName(name: string, sourceId: string): string {
  const suffix = sourceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, DISAMBIGUATION_ID_LENGTH) || "x"
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return `${name}~${suffix}`
  return `${name.slice(0, dot)}~${suffix}${name.slice(dot)}`
}

/** Assign each row its addressable name within one mount. */
function assignNames<T extends NamedRow>(rows: readonly T[]): Map<T, string> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  return new Map(
    rows.map((row) => [
      row,
      (counts.get(row.name) ?? 0) > 1 ? disambiguatedName(row.name, row.sourceId) : row.name,
    ])
  )
}

export function projectUploadEntries(assets: readonly ListedSessionAsset[]): FileSpaceDexieEntry[] {
  const rows = assets
    .filter((asset) => !asset.deletedAt)
    .map((asset) => ({
      asset,
      sourceId: asset.assetId,
      name: fileSpaceSegmentName(asset.filename, "upload"),
      createdAt: asset.createdAt,
    }))
  const names = assignNames(rows)
  return rows.flatMap((row) => {
    const path = joinFileSpacePath(UPLOADS_MOUNT_PATH, names.get(row) ?? row.name)
    if (!path) return []
    return [
      {
        mountId: "uploads" as const,
        path,
        name: row.name,
        size: row.asset.byteSize,
        mediaType: row.asset.mediaType,
        createdAt: row.asset.createdAt,
        updatedAt: row.asset.updatedAt,
        sourceId: row.asset.assetId,
        sourceAvailable: row.asset.sourceAvailable,
      },
    ]
  })
}

/** The media type an artifact's raw source is served as. */
export function artifactMediaType(type: ArtifactRow["type"]): string {
  switch (type) {
    case "html":
      return "text/html"
    case "svg":
      return "image/svg+xml"
    case "document":
      return "text/markdown"
    case "chart":
    case "jupyter":
      return "application/json"
    default:
      return "text/plain"
  }
}

const utf8 = new TextEncoder()

export function projectArtifactEntries(artifacts: readonly ArtifactRow[]): FileSpaceDexieEntry[] {
  const rows = artifacts.map((artifact) => ({
    artifact,
    sourceId: artifact.id,
    name: `${fileSpaceSegmentName(artifact.title, "artifact")}.${getArtifactExtension(
      artifact.type,
      artifact.language
    )}`,
    createdAt: artifact.createdAt,
  }))
  const names = assignNames(rows)
  return rows.flatMap((row) => {
    const path = joinFileSpacePath(ARTIFACTS_MOUNT_PATH, names.get(row) ?? row.name)
    if (!path) return []
    return [
      {
        mountId: "artifacts" as const,
        path,
        name: row.name,
        size: utf8.encode(row.artifact.content ?? "").byteLength,
        mediaType: artifactMediaType(row.artifact.type),
        createdAt: row.artifact.createdAt,
        updatedAt: row.artifact.updatedAt,
        sourceId: row.artifact.id,
        sourceAvailable: true,
      },
    ]
  })
}

/**
 * The entry a path inside a Dexie mount names, per the naming rules above.
 * `entries` is one mount's full listing.
 */
export function findDexieEntry(
  entries: readonly FileSpaceDexieEntry[],
  path: FileSpacePath
): FileSpaceDexieEntry | null {
  const exact = entries.find((entry) => entry.path === path)
  if (exact) return exact
  const cut = path.lastIndexOf("/")
  const name = path.slice(cut + 1)
  const prefix = `${path.slice(0, cut)}/`
  let oldest: FileSpaceDexieEntry | null = null
  for (const entry of entries) {
    if (entry.name !== name || !entry.path.startsWith(prefix)) continue
    if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry
  }
  return oldest
}

export interface FileSpaceDexieListing {
  uploads: FileSpaceDexieEntry[]
  artifacts: FileSpaceDexieEntry[]
}

/** Read both Dexie mounts of one conversation. */
export async function listFileSpaceDexieEntries(sessionId: string): Promise<FileSpaceDexieListing> {
  const [assets, artifacts] = await Promise.all([
    listSessionAssets(sessionId),
    getDb().artifacts.where("sessionId").equals(sessionId).toArray() as Promise<ArtifactRow[]>,
  ])
  return {
    uploads: projectUploadEntries([...assets].sort((a, b) => a.createdAt - b.createdAt)),
    artifacts: projectArtifactEntries([...artifacts].sort((a, b) => a.createdAt - b.createdAt)),
  }
}
