import fs from "node:fs"
import path from "node:path"

import { hashHex } from "../../runtime/crypto-hasher"

export interface AssetRecord {
  assetId: string
  digest: string
  mediaType: string
  byteLength: number
  name?: string
  /** Set when the asset is a registered host path rather than stored bytes. */
  sourcePath?: string
}

export class AssetStoreError extends Error {
  constructor(
    readonly code: "not_found" | "too_large" | "unreadable" | "invalid",
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = "AssetStoreError"
  }
}

export interface AssetStore {
  put(options: { data: string; mediaType: string; name?: string }): AssetRecord
  registerPath(options: { path: string; mediaType?: string }): AssetRecord
  stat(assetId: string): AssetRecord
  delete(assetId: string): void
  /** Absolute path to the bytes, for the runtime that will actually read them. */
  resolve(assetId: string): string
}

/** Refuse anything larger than this in one `asset/put`. */
export const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
}

/**
 * Content-addressed storage for turn inputs.
 *
 * Assets exist so that a turn carries `{assetId, digest, mediaType, byteLength}`
 * and nothing else. Raw bytes never enter the canonical event log — which is
 * replayed, exported and shared — and neither do host-local paths, which would
 * be meaningless to any other machine that read the log.
 *
 * Storage is by digest, so uploading the same bytes twice costs one copy and
 * yields one id. A registered path is *not* copied: the host records where the
 * bytes are and the digest they had, so a later read can tell that the file
 * changed underneath it.
 */
export function createAssetStore(options: {
  home: string
  maxBytes?: number
  now?: () => number
}): AssetStore {
  const root = path.join(options.home, "assets")
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ASSET_BYTES
  const now = options.now ?? Date.now

  function metaPath(assetId: string): string {
    return path.join(root, `${assetId}.json`)
  }

  function blobPath(assetId: string): string {
    return path.join(root, `${assetId}.blob`)
  }

  function writeAtomic(target: string, contents: Buffer | string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${process.pid}.${now()}.tmp`
    fs.writeFileSync(temporary, contents, { mode: 0o600 })
    fs.renameSync(temporary, target)
  }

  function readRecord(assetId: string): AssetRecord {
    try {
      return JSON.parse(fs.readFileSync(metaPath(assetId), "utf8")) as AssetRecord
    } catch {
      throw new AssetStoreError("not_found", `unknown asset ${assetId}`, { assetId })
    }
  }

  function idFor(digest: string): string {
    return `asset-${digest.replace(/^sha256-/, "").slice(0, 32)}`
  }

  return {
    put({ data, mediaType, name }) {
      if (typeof mediaType !== "string" || mediaType.length === 0) {
        throw new AssetStoreError("invalid", "mediaType is required")
      }
      let bytes: Buffer
      try {
        bytes = Buffer.from(data, "base64")
      } catch {
        throw new AssetStoreError("invalid", "data must be base64")
      }
      if (bytes.byteLength > maxBytes) {
        throw new AssetStoreError(
          "too_large",
          `asset is ${bytes.byteLength} bytes; this host accepts at most ${maxBytes}`,
          { byteLength: bytes.byteLength, maxBytes }
        )
      }
      const digest = `sha256-${hashHex("sha256", bytes)}`
      const assetId = idFor(digest)
      const record: AssetRecord = {
        assetId,
        digest,
        mediaType,
        byteLength: bytes.byteLength,
        ...(name !== undefined ? { name } : {}),
      }
      // Content-addressed: re-uploading identical bytes is a no-op.
      if (!fs.existsSync(blobPath(assetId))) writeAtomic(blobPath(assetId), bytes)
      writeAtomic(metaPath(assetId), `${JSON.stringify(record)}\n`)
      return record
    },

    registerPath({ path: sourcePath, mediaType }) {
      let stats: fs.Stats
      try {
        stats = fs.statSync(sourcePath)
      } catch {
        throw new AssetStoreError("unreadable", `cannot read ${sourcePath}`, { path: sourcePath })
      }
      if (!stats.isFile()) {
        throw new AssetStoreError("invalid", `${sourcePath} is not a regular file`, {
          path: sourcePath,
        })
      }
      if (stats.size > maxBytes) {
        throw new AssetStoreError(
          "too_large",
          `${sourcePath} is ${stats.size} bytes; this host accepts at most ${maxBytes}`,
          { byteLength: stats.size, maxBytes }
        )
      }
      const bytes = fs.readFileSync(sourcePath)
      const digest = `sha256-${hashHex("sha256", bytes)}`
      const assetId = idFor(digest)
      const record: AssetRecord = {
        assetId,
        digest,
        mediaType:
          mediaType ??
          MEDIA_TYPE_BY_EXTENSION[path.extname(sourcePath).toLowerCase()] ??
          "application/octet-stream",
        byteLength: stats.size,
        name: path.basename(sourcePath),
        sourcePath: path.resolve(sourcePath),
      }
      writeAtomic(metaPath(assetId), `${JSON.stringify(record)}\n`)
      return record
    },

    stat(assetId) {
      return readRecord(assetId)
    },

    delete(assetId) {
      const record = readRecord(assetId)
      fs.rmSync(metaPath(assetId), { force: true })
      // A registered path belongs to the caller; only stored blobs are ours.
      if (!record.sourcePath) fs.rmSync(blobPath(assetId), { force: true })
    },

    resolve(assetId) {
      const record = readRecord(assetId)
      const target = record.sourcePath ?? blobPath(assetId)
      if (!fs.existsSync(target)) {
        throw new AssetStoreError("unreadable", `asset ${assetId} is no longer readable`, {
          assetId,
          path: target,
        })
      }
      if (record.sourcePath) {
        // Registered paths are not copied, so the file can change underneath us.
        const digest = `sha256-${hashHex("sha256", fs.readFileSync(target))}`
        if (digest !== record.digest) {
          throw new AssetStoreError(
            "unreadable",
            `asset ${assetId} changed on disk since it was registered`,
            { assetId, expected: record.digest, actual: digest }
          )
        }
      }
      return target
    },
  }
}
