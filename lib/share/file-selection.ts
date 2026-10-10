// Turning what the user picked in a conversation's FileSpace into the files a
// share carries (ADR-0222 §6.3).
//
// A selection is FileSpace paths — files, directories, or a whole mount.
// Directories are snapshotted as their current file list: on a disk mount
// through the ignore-aware walk (`walkWorkspaceTree`), which already drops
// the sensitive floor and counts what it dropped; on a Dexie mount (uploads,
// artifacts) by listing its rows. A file picked on its own is never dropped
// silently: one the floor refuses comes back flagged `sensitive`, and the
// dialog shares it only with an explicit per-file opt-in.
//
// Nothing is read here beyond metadata. Each candidate opens its bytes lazily
// (`open`) when the share is actually created.

import { walkWorkspaceTree } from "@/lib/files/workspace-walk"
import { statWorkspaceFile } from "@/lib/files/workspace-fs"
import { getDb } from "@/lib/db/schema"
import { getSessionAsset } from "@/lib/db/session-assets"
import { isSensitivePath } from "@/lib/filespace/sensitive"
import {
  findDexieEntry,
  listFileSpaceDexieEntries,
  type FileSpaceDexieListing,
} from "@/lib/filespace/sources"
import { joinFileSpacePath, locateFileSpacePath } from "@/lib/filespace/paths"
import type {
  ConversationFileSpace,
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpacePath,
} from "@/types/filespace"

import {
  SHARE_MAX_BLOBS,
  SHARE_MAX_BLOB_BYTES,
  SHARE_MAX_TOTAL_BLOB_BYTES,
  shareBlobStoredBytes,
} from "./blob-crypto"
import type { ShareBlobSource } from "./blobs"
import { blobShareSource, textShareSource, workspaceShareSource } from "./file-sources"

/** One file the share would carry. */
export interface ShareFileCandidate {
  path: FileSpacePath
  name: string
  mime: string
  size: number
  /** Refused by the sensitive floor; shared only after an explicit opt-in. */
  sensitive: boolean
  /** Open the bytes. Rejects when they are gone. */
  open: () => Promise<ShareBlobSource>
}

/** Why a selected path contributed no files. */
export type ShareSelectionIssueReason =
  "not-found" | "outside" | "offline" | "no-backend" | "source-unavailable"

export interface ShareSelectionIssue {
  path: FileSpacePath
  reason: ShareSelectionIssueReason
}

export interface ExpandedShareSelection {
  /** Sorted by path, each path once. */
  files: ShareFileCandidate[]
  /** Files a directory walk withheld under the sensitive floor. */
  skippedSensitive: number
  /** A directory had more files than a share may carry; the list stops early. */
  truncated: boolean
  issues: ShareSelectionIssue[]
}

/** Raised when a candidate's bytes are gone by the time it is opened. */
export class ShareFileSourceUnavailableError extends Error {
  constructor(readonly path: string) {
    super(`${path} is no longer available to share`)
    this.name = "ShareFileSourceUnavailableError"
  }
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  ipynb: "application/json",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsx: "text/javascript",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  mjs: "text/javascript",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  py: "text/x-python",
  rs: "text/x-rust",
  sh: "text/x-shellscript",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  toml: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
}

/** The media type a shared file is served as, from its name. */
export function mimeForFileName(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return "application/octet-stream"
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream"
}

export interface FileSelectionDeps {
  statWorkspaceFile: typeof statWorkspaceFile
  walkWorkspaceTree: typeof walkWorkspaceTree
  listFileSpaceDexieEntries: typeof listFileSpaceDexieEntries
  getSessionAsset: typeof getSessionAsset
  getArtifactContent: (artifactId: string) => Promise<string | undefined>
}

export const defaultFileSelectionDeps: FileSelectionDeps = {
  statWorkspaceFile,
  walkWorkspaceTree,
  listFileSpaceDexieEntries,
  getSessionAsset,
  getArtifactContent: async (artifactId) => (await getDb().artifacts.get(artifactId))?.content,
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function diskIssue(mount: FileSpaceMount): ShareSelectionIssueReason | null {
  if (mount.status === "available" && mount.hostPath) return null
  if (mount.statusReason === "no-fs-backend") return "no-backend"
  if (mount.status === "offline") return "offline"
  return "not-found"
}

/**
 * Expand a FileSpace selection into the files a share would carry. Stops
 * once it has one more file than a share may hold, so a whole-repository
 * pick cannot walk forever; `truncated` says so.
 */
export async function expandShareSelection(
  space: ConversationFileSpace,
  paths: readonly FileSpacePath[],
  deps: FileSelectionDeps = defaultFileSelectionDeps
): Promise<ExpandedShareSelection> {
  const files = new Map<FileSpacePath, ShareFileCandidate>()
  const issues: ShareSelectionIssue[] = []
  let skippedSensitive = 0
  let truncated = false
  let dexie: FileSpaceDexieListing | null = null
  const limit = SHARE_MAX_BLOBS + 1

  const add = (candidate: ShareFileCandidate) => {
    if (files.size >= limit) {
      truncated = true
      return
    }
    if (!files.has(candidate.path)) files.set(candidate.path, candidate)
  }

  const dexieCandidate = (entry: FileSpaceDexieEntry): ShareFileCandidate => ({
    path: entry.path,
    name: entry.name,
    mime: entry.mediaType || mimeForFileName(entry.name),
    size: entry.size,
    sensitive: isSensitivePath(entry.path),
    open: async () => {
      if (entry.mountId === "uploads") {
        const asset = await deps.getSessionAsset(space.sessionId, entry.sourceId)
        if (!asset) throw new ShareFileSourceUnavailableError(entry.path)
        return blobShareSource(asset.blob)
      }
      const content = await deps.getArtifactContent(entry.sourceId)
      if (content === undefined) throw new ShareFileSourceUnavailableError(entry.path)
      return textShareSource(content)
    },
  })

  for (const path of paths) {
    if (truncated) break
    const located = locateFileSpacePath(space, path)
    if (!located) {
      issues.push({ path, reason: "outside" })
      continue
    }
    const { mount, relPath } = located

    if (mount.backing === "dexie") {
      dexie ??= await deps.listFileSpaceDexieEntries(space.sessionId)
      const entries = mount.id === "uploads" ? dexie.uploads : dexie.artifacts
      if (relPath === "") {
        for (const entry of entries) {
          if (!entry.sourceAvailable) continue
          if (isSensitivePath(entry.path)) {
            skippedSensitive++
            continue
          }
          add(dexieCandidate(entry))
        }
        continue
      }
      const entry = findDexieEntry(entries, path)
      if (!entry) issues.push({ path, reason: "not-found" })
      else if (!entry.sourceAvailable) issues.push({ path, reason: "source-unavailable" })
      else add(dexieCandidate(entry))
      continue
    }

    const blocked = diskIssue(mount)
    if (blocked) {
      issues.push({ path, reason: blocked })
      continue
    }
    const root = mount.hostPath!
    const diskCandidate = (rel: string, size: number): ShareFileCandidate | null => {
      const candidatePath = joinFileSpacePath(mount.virtualPath, rel)
      if (!candidatePath) return null
      return {
        path: candidatePath,
        name: baseName(rel),
        mime: mimeForFileName(baseName(rel)),
        size,
        sensitive: isSensitivePath(rel),
        open: async () => workspaceShareSource(root, rel, size, candidatePath),
      }
    }

    const stat = relPath === "" ? null : await deps.statWorkspaceFile(root, relPath)
    if (stat && !stat.exists) {
      issues.push({ path, reason: "not-found" })
      continue
    }
    if (stat && !stat.isDir) {
      const candidate = diskCandidate(relPath, stat.size)
      if (candidate) add(candidate)
      continue
    }
    const walk = await deps.walkWorkspaceTree(root, {
      relPath: relPath || undefined,
      includeIgnored: false,
      maxEntries: limit,
      sensitiveFloor: true,
    })
    skippedSensitive += walk.skippedSensitive
    if (walk.truncated) truncated = true
    for (const entry of walk.entries) {
      if (entry.isDir) continue
      // The walk applies the floor itself; this catches a walk that started
      // inside a refused directory on a Host whose floor predates the list.
      if (isSensitivePath(entry.relPath)) {
        skippedSensitive++
        continue
      }
      const candidate = diskCandidate(entry.relPath, entry.size)
      if (candidate) add(candidate)
    }
  }

  const sorted = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return { files: sorted, skippedSensitive, truncated, issues }
}

/** A share that would exceed what the server accepts. */
export type ShareSelectionLimitViolation =
  | { kind: "too-many-files"; count: number; max: number }
  | { kind: "file-too-large"; path: string; size: number; max: number }
  | { kind: "total-too-large"; total: number; max: number }

/**
 * Check the files a share will carry against the server's limits: file
 * count, per-file size, and the ciphertext total the server's quota counts.
 */
export function checkShareSelectionLimits(
  files: readonly { path: string; size: number }[]
): ShareSelectionLimitViolation[] {
  const violations: ShareSelectionLimitViolation[] = []
  if (files.length > SHARE_MAX_BLOBS) {
    violations.push({ kind: "too-many-files", count: files.length, max: SHARE_MAX_BLOBS })
  }
  let total = 0
  for (const file of files) {
    if (file.size > SHARE_MAX_BLOB_BYTES) {
      violations.push({
        kind: "file-too-large",
        path: file.path,
        size: file.size,
        max: SHARE_MAX_BLOB_BYTES,
      })
    }
    total += shareBlobStoredBytes(file.size)
  }
  if (total > SHARE_MAX_TOTAL_BLOB_BYTES) {
    violations.push({ kind: "total-too-large", total, max: SHARE_MAX_TOTAL_BLOB_BYTES })
  }
  return violations
}
