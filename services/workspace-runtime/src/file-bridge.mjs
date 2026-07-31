import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function safeFilename(value) {
  const name = path.basename(String(value)).replace(/[\0/\\]/g, "_")
  return name || "download"
}

export class WorkspaceFileBridge {
  constructor({
    workspaceRoot,
    maxUploadFiles = 10,
    maxUploadFileBytes = 100 * 1024 * 1024,
    maxDownloadFileBytes = 250 * 1024 * 1024,
    maxSessionDownloadBytes = 1024 * 1024 * 1024,
  }) {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.quarantineRoot = path.join(this.workspaceRoot, ".cognia", "browser-downloads")
    this.maxUploadFiles = maxUploadFiles
    this.maxUploadFileBytes = maxUploadFileBytes
    this.maxDownloadFileBytes = maxDownloadFileBytes
    this.maxSessionDownloadBytes = maxSessionDownloadBytes
    this.downloads = new Map()
    this.ready = Promise.all([
      fs.realpath(this.workspaceRoot),
      fs.mkdir(this.quarantineRoot, { recursive: true }),
    ]).then(([realRoot]) => {
      this.realWorkspaceRoot = realRoot
    })
  }

  async resolveUploads(relativePaths) {
    await this.ready
    if (relativePaths.length > this.maxUploadFiles) throw new Error("too many upload files")
    const resolved = []
    for (const relativePath of relativePaths) {
      if (path.isAbsolute(relativePath)) throw new Error("upload path is outside workspace")
      const lexical = path.resolve(this.workspaceRoot, relativePath)
      if (!isWithin(this.workspaceRoot, lexical))
        throw new Error("upload path is outside workspace")
      const real = await fs.realpath(lexical)
      if (!isWithin(this.realWorkspaceRoot, real))
        throw new Error("upload path is outside workspace")
      const stat = await fs.stat(real)
      if (!stat.isFile()) throw new Error("upload path is not a file")
      if (stat.size > this.maxUploadFileBytes) throw new Error("upload file is too large")
      resolved.push(real)
    }
    return resolved
  }

  async quarantineDownload(sessionId, suggestedName, bytes) {
    await this.ready
    const payload = Buffer.from(bytes)
    if (payload.length > this.maxDownloadFileBytes) throw new Error("download file is too large")
    const currentBytes = this.listDownloads(sessionId).reduce((sum, item) => sum + item.size, 0)
    if (currentBytes + payload.length > this.maxSessionDownloadBytes) {
      throw new Error("session download quota exceeded")
    }
    const id = crypto.randomUUID()
    const filename = safeFilename(suggestedName)
    const quarantinePath = path.join(this.quarantineRoot, `${id}-${filename}`)
    await fs.writeFile(quarantinePath, payload, { flag: "wx", mode: 0o600 })
    const record = {
      id,
      sessionId,
      filename,
      size: payload.length,
      state: "quarantined",
      quarantinePath,
    }
    this.downloads.set(id, record)
    return this.publicDownload(record)
  }

  listDownloads(sessionId) {
    return [...this.downloads.values()]
      .filter((item) => item.sessionId === sessionId)
      .map((item) => this.publicDownload(item))
  }

  async saveDownload(id, relativePath) {
    await this.ready
    const record = this.requireDownload(id)
    if (path.isAbsolute(relativePath)) throw new Error("save path is outside workspace")
    const destination = path.resolve(this.workspaceRoot, relativePath)
    if (!isWithin(this.workspaceRoot, destination))
      throw new Error("save path is outside workspace")
    const realParent = await fs.realpath(path.dirname(destination))
    if (!isWithin(this.realWorkspaceRoot, realParent))
      throw new Error("save path is outside workspace")
    await fs.copyFile(record.quarantinePath, destination, fs.constants.COPYFILE_EXCL)
    await fs.rm(record.quarantinePath, { force: true })
    record.state = "saved"
    record.savedRelativePath = path.relative(this.workspaceRoot, destination)
    return this.publicDownload(record)
  }

  async readForChat(id) {
    await this.ready
    const record = this.requireDownload(id)
    if (record.state !== "quarantined") throw new Error("download is not quarantined")
    const bytes = await fs.readFile(record.quarantinePath)
    record.state = "attached"
    return { ...this.publicDownload(record), bytes }
  }

  async deleteDownload(id) {
    await this.ready
    const record = this.requireDownload(id)
    if (record.quarantinePath) await fs.rm(record.quarantinePath, { force: true })
    this.downloads.delete(id)
  }

  async cleanupSession(sessionId) {
    for (const item of this.listDownloads(sessionId)) await this.deleteDownload(item.id)
  }

  requireDownload(id) {
    const record = this.downloads.get(id)
    if (!record) throw new Error("download not found")
    return record
  }

  publicDownload({ quarantinePath: _quarantinePath, ...record }) {
    return { ...record }
  }
}
