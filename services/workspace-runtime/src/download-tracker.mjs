import fs from "node:fs/promises"
import path from "node:path"

import { RemoteBrowserError } from "./browser-errors.mjs"
import { reserveUniquePath, safeFilename } from "./local-files.mjs"

const MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

/**
 * Refuse a save target that is a symlink or whose parent directory is one.
 * An existing regular file is left to the exclusive open (`target_exists`).
 */
async function assertSafeSaveTarget(target) {
  const parent = path.dirname(target)
  let parentStat
  try {
    parentStat = await fs.lstat(parent)
  } catch {
    throw new RemoteBrowserError(
      "browser_download_target_invalid",
      "Target directory does not exist"
    )
  }
  if (parentStat.isSymbolicLink()) {
    throw new RemoteBrowserError(
      "browser_download_target_invalid",
      "Target directory must not be a symbolic link"
    )
  }
  if (!parentStat.isDirectory()) {
    throw new RemoteBrowserError(
      "browser_download_target_invalid",
      "Target directory is not a directory"
    )
  }
  let targetStat = null
  try {
    targetStat = await fs.lstat(target)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (targetStat?.isSymbolicLink()) {
    throw new RemoteBrowserError(
      "browser_download_target_invalid",
      "Target path must not be a symbolic link"
    )
  }
  if (targetStat) {
    throw new RemoteBrowserError("browser_download_target_exists", "Target file exists")
  }
}

function mimeTypeFor(filename) {
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()]
}

function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/**
 * Tracks the downloads of one local-mode browser session (ADR-0201).
 *
 * Two independent sources feed it and are joined by `url` + suggested name:
 * - Playwright `download` events (`kind: "local"`): own the bytes. On success
 *   the artifact is copied with `saveAs` into `downloadsDir` under a
 *   collision-safe name; Playwright deletes its staging artifact on close.
 * - CDP `Browser.downloadWillBegin` / `Browser.downloadProgress`: progress for
 *   `kind: "local"`, and the only source for `kind: "user-chrome"`, where the
 *   user's Chrome saves the file itself (`filePath` when Chrome reports it).
 *
 * Every state change (and throttled progress) is published as a
 * `download.updated` event carrying the public `BrowserDownloadSummary`.
 */
export class LocalDownloadTracker {
  constructor({
    sessionId,
    backend,
    downloadsDir,
    createId,
    publish,
    cancelByGuid = async () => undefined,
    now = () => Date.now(),
    progressIntervalMs = 250,
  }) {
    this.sessionId = sessionId
    this.backend = backend
    this.downloadsDir = downloadsDir
    this.createId = createId
    this.publish = publish
    this.cancelByGuid = cancelByGuid
    this.now = now
    this.progressIntervalMs = progressIntervalMs
    this.records = new Map()
  }

  createRecord({ url, suggestedFilename }) {
    const filename = safeFilename(suggestedFilename)
    const record = {
      id: this.createId(),
      url: typeof url === "string" ? url : undefined,
      suggestedFilename: filename,
      filename,
      state: "in_progress",
      receivedBytes: 0,
      totalBytes: undefined,
      startedAt: this.now(),
      finishedAt: undefined,
      savedPath: undefined,
      filePath: undefined,
      error: undefined,
      guid: undefined,
      download: undefined,
      cancelRequested: false,
      lastProgressPublishedAt: 0,
    }
    this.records.set(record.id, record)
    return record
  }

  findUnlinked(field, url, suggestedFilename) {
    const filename = safeFilename(suggestedFilename)
    for (const record of this.records.values()) {
      if (record[field] !== undefined) continue
      if (record.state !== "in_progress") continue
      if (record.url === url && record.suggestedFilename === filename) return record
    }
    return null
  }

  /** CDP `Browser.downloadWillBegin`. */
  onWillBegin({ guid, url, suggestedFilename }) {
    if (typeof guid !== "string" || this.findByGuid(guid)) return null
    let record = this.findUnlinked("guid", url, suggestedFilename)
    const created = !record
    if (!record) record = this.createRecord({ url, suggestedFilename })
    record.guid = guid
    if (created) this.emit(record)
    return record
  }

  /** CDP `Browser.downloadProgress`. */
  onProgress({ guid, totalBytes, receivedBytes, state, filePath }) {
    const record = this.findByGuid(guid)
    if (!record || record.state !== "in_progress") return
    const total = nonNegative(totalBytes)
    const received = nonNegative(receivedBytes)
    if (total !== undefined && total > 0) record.totalBytes = total
    if (received !== undefined) record.receivedBytes = received
    if (record.download) {
      // Playwright owns completion for launched Chromium; CDP only adds progress.
      if (state === "inProgress") this.emitProgress(record)
      return
    }
    if (state === "completed") {
      if (typeof filePath === "string" && filePath) {
        record.filePath = filePath
        record.savedPath = filePath
        record.filename = path.basename(filePath)
      }
      this.finish(record, "completed")
    } else if (state === "canceled") {
      this.finish(record, record.cancelRequested ? "cancelled" : "failed", "canceled")
    } else {
      this.emitProgress(record)
    }
  }

  /** Playwright page `download` event (`kind: "local"`). */
  async onPlaywrightDownload(download) {
    const url = download.url()
    const suggestedFilename = download.suggestedFilename()
    let record = this.findUnlinked("download", url, suggestedFilename)
    const created = !record
    if (!record) record = this.createRecord({ url, suggestedFilename })
    record.download = download
    if (created) this.emit(record)
    await this.settlePlaywrightDownload(record)
    return this.summary(record)
  }

  async settlePlaywrightDownload(record) {
    const { download } = record
    let stagedPath = null
    try {
      stagedPath = await download.path()
    } catch {
      stagedPath = null
    }
    if (!stagedPath) {
      let failure = null
      try {
        failure = await download.failure()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      const cancelled = record.cancelRequested || failure === "canceled"
      this.finish(record, cancelled ? "cancelled" : "failed", cancelled ? undefined : failure)
      return
    }
    if (record.state !== "in_progress") return
    let target = null
    try {
      target = await reserveUniquePath(this.downloadsDir, record.suggestedFilename)
      await download.saveAs(target)
      const stat = await fs.stat(target)
      record.filePath = target
      record.savedPath = target
      record.filename = path.basename(target)
      record.receivedBytes = stat.size
      record.totalBytes = stat.size
      this.finish(record, "completed")
    } catch (error) {
      if (target) await fs.rm(target, { force: true }).catch(() => undefined)
      this.finish(record, "failed", error instanceof Error ? error.message : String(error))
    }
  }

  /** Register a file the runtime itself produced (e.g. `browser.pdf`). */
  addCompletedFile({ filePath, url }) {
    const filename = path.basename(filePath)
    const record = this.createRecord({ url, suggestedFilename: filename })
    record.filename = filename
    record.filePath = filePath
    record.savedPath = filePath
    return fs.stat(filePath).then((stat) => {
      record.receivedBytes = stat.size
      record.totalBytes = stat.size
      this.finish(record, "completed")
      return this.summary(record)
    })
  }

  finish(record, state, error) {
    if (record.state !== "in_progress") return
    record.state = state
    record.finishedAt = this.now()
    if (error && state === "failed") record.error = String(error)
    this.emit(record)
  }

  emitProgress(record) {
    const at = this.now()
    if (at - record.lastProgressPublishedAt < this.progressIntervalMs) return
    record.lastProgressPublishedAt = at
    this.emit(record)
  }

  emit(record) {
    this.publish({
      type: "download.updated",
      sessionId: this.sessionId,
      download: this.summary(record),
    })
  }

  findByGuid(guid) {
    for (const record of this.records.values()) if (record.guid === guid) return record
    return null
  }

  require(downloadId) {
    const record = this.records.get(downloadId)
    if (!record) throw new RemoteBrowserError("browser_download_not_found", "Download not found")
    return record
  }

  list() {
    return [...this.records.values()].map((record) => this.summary(record))
  }

  async cancel(downloadId) {
    const record = this.require(downloadId)
    if (record.state !== "in_progress") {
      throw new RemoteBrowserError(
        "browser_download_not_cancellable",
        "Only an in-progress download can be cancelled"
      )
    }
    record.cancelRequested = true
    if (record.download) {
      await record.download.cancel()
    } else if (record.guid) {
      await this.cancelByGuid(record.guid)
    }
    // Playwright/CDP report the terminal state asynchronously; the record is
    // cancelled from the caller's point of view right away.
    this.finish(record, "cancelled")
    return this.summary(record)
  }

  async delete(downloadId) {
    const record = this.require(downloadId)
    if (record.state === "in_progress") await this.cancel(downloadId)
    if (record.filePath) await fs.rm(record.filePath, { force: true })
    this.records.delete(downloadId)
    return { deleted: true, id: downloadId }
  }

  /**
   * Privileged (Rust-only, after a native save dialog): copy a finished
   * download to `targetPath`. Never overwrites, and refuses a target that is a
   * symlink (even a dangling one) or whose parent directory is a symlink, so a
   * planted link cannot redirect the bytes elsewhere. The destination is
   * opened with `O_CREAT | O_EXCL`, which also refuses a symlink created
   * between the check and the write.
   */
  async save(downloadId, targetPath) {
    const record = this.require(downloadId)
    if (!["completed", "saved"].includes(record.state) || !record.filePath) {
      throw new RemoteBrowserError(
        "browser_download_not_ready",
        "Only a completed download can be saved"
      )
    }
    if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
      throw new RemoteBrowserError(
        "browser_download_target_invalid",
        "Target path must be absolute"
      )
    }
    const target = path.normalize(targetPath)
    await assertSafeSaveTarget(target)
    let destination
    try {
      destination = await fs.open(target, "wx", 0o644)
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new RemoteBrowserError("browser_download_target_exists", "Target file exists")
      }
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new RemoteBrowserError(
          "browser_download_target_invalid",
          "Target directory does not exist"
        )
      }
      throw error
    }
    try {
      let source
      try {
        source = await fs.open(record.filePath, "r")
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new RemoteBrowserError(
            "browser_download_target_invalid",
            "Downloaded file no longer exists"
          )
        }
        throw error
      }
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
          if (bytesRead === 0) break
          let written = 0
          while (written < bytesRead) {
            const result = await destination.write(buffer, written, bytesRead - written)
            written += result.bytesWritten
          }
        }
      } finally {
        await source.close()
      }
      await destination.close()
      destination = null
    } catch (error) {
      await destination?.close().catch(() => undefined)
      // Remove the partial file this call created (never a pre-existing one:
      // `wx` guaranteed we created it).
      await fs.rm(target, { force: true }).catch(() => undefined)
      throw error
    }
    record.state = "saved"
    record.savedPath = target
    this.emit(record)
    return this.summary(record)
  }

  summary(record) {
    const size =
      record.state === "in_progress"
        ? record.receivedBytes
        : (record.totalBytes ?? record.receivedBytes)
    return {
      id: record.id,
      sessionId: this.sessionId,
      filename: record.filename,
      size: size ?? 0,
      ...(record.url ? { url: record.url } : {}),
      ...(mimeTypeFor(record.filename) ? { mimeType: mimeTypeFor(record.filename) } : {}),
      ...(record.totalBytes !== undefined ? { totalBytes: record.totalBytes } : {}),
      receivedBytes: record.receivedBytes,
      startedAt: record.startedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(record.savedPath ? { savedPath: record.savedPath } : {}),
      ...(record.error ? { error: record.error } : {}),
      backend: this.backend,
      state: record.state,
    }
  }
}
