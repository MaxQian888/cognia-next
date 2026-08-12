import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"

const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_FOLDER_FILES = 1000

function cleanName(value) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("attachment name is required")
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // A plain UTF-8 header value is also accepted.
  }
  const leaf = basename(decoded.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  if (!leaf || leaf === "." || leaf === "..") throw new Error("attachment name is invalid")
  if (leaf.length > 240) throw new Error("attachment name exceeds 240 characters")
  return leaf
}

function cleanRelativePath(value, rootName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("attachment relative path is required")
  }
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // A plain UTF-8 header value is also accepted.
  }
  const segments = decoded.replaceAll("\\", "/").split("/")
  if (segments[0] === rootName) segments.shift()
  if (
    !segments.length ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("attachment relative path is invalid")
  }
  for (const segment of segments) {
    if (/[\u0000-\u001f\u007f]/.test(segment) || segment.length > 240) {
      throw new Error("attachment relative path is invalid")
    }
  }
  const relativePath = segments.join("/")
  if (relativePath.length > 2048) throw new Error("attachment relative path is too long")
  return relativePath
}

function publicAttachment(value) {
  const { path: _path, ...metadata } = value
  return metadata
}

export function createAttachmentStore(options = {}) {
  const root = options.root ?? join(tmpdir(), `cognia-codex-relay-${process.getuid()}`, "uploads")
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxFolderFiles = options.maxFolderFiles ?? DEFAULT_MAX_FOLDER_FILES
  const attachments = new Map()

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 })
  }

  function totalBytes() {
    return [...attachments.values()].reduce((total, attachment) => total + attachment.size, 0)
  }

  async function upload(readable, metadata = {}) {
    if (attachments.size >= maxFiles) throw new Error(`attachment limit is ${maxFiles} files`)
    const name = cleanName(metadata.name)
    const declaredLength = Number(metadata.contentLength)
    if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
      throw new Error(`attachment exceeds ${maxFileBytes} bytes`)
    }
    if (Number.isFinite(declaredLength) && totalBytes() + declaredLength > maxTotalBytes) {
      throw new Error(`attachment storage exceeds ${maxTotalBytes} bytes`)
    }

    await initialize()
    const id = randomUUID()
    const directory = join(root, id)
    const path = join(directory, name)
    await mkdir(directory, { mode: 0o700 })
    const file = await open(path, "wx", 0o600)
    const digest = createHash("sha256")
    let size = 0
    try {
      for await (const chunk of readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > maxFileBytes) throw new Error(`attachment exceeds ${maxFileBytes} bytes`)
        if (totalBytes() + size > maxTotalBytes) {
          throw new Error(`attachment storage exceeds ${maxTotalBytes} bytes`)
        }
        digest.update(bytes)
        await file.write(bytes)
      }
    } catch (error) {
      await file.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    await file.close()

    const attachment = {
      id,
      kind: "file",
      name,
      mimeType: String(metadata.mimeType || "application/octet-stream").slice(0, 255),
      size,
      sha256: digest.digest("hex"),
      createdAt: new Date().toISOString(),
      path,
    }
    attachments.set(id, attachment)
    return publicAttachment(attachment)
  }

  async function createFolder(metadata = {}) {
    if (attachments.size >= maxFiles) throw new Error(`attachment limit is ${maxFiles} items`)
    const name = cleanName(metadata.name)
    await initialize()
    const id = randomUUID()
    const directory = join(root, id)
    const path = join(directory, name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const attachment = {
      id,
      kind: "folder",
      name,
      mimeType: "inode/directory",
      size: 0,
      fileCount: 0,
      sha256: null,
      createdAt: new Date().toISOString(),
      path,
    }
    attachments.set(id, attachment)
    return publicAttachment(attachment)
  }

  async function uploadFolderFile(id, readable, metadata = {}) {
    const attachment = attachments.get(id)
    if (!attachment || attachment.kind !== "folder")
      throw new Error(`folder attachment not found: ${id}`)
    if (attachment.fileCount >= maxFolderFiles) {
      throw new Error(`folder attachment limit is ${maxFolderFiles} files`)
    }
    const relativePath = cleanRelativePath(metadata.relativePath, attachment.name)
    const declaredLength = Number(metadata.contentLength)
    if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) {
      throw new Error(`attachment exceeds ${maxFileBytes} bytes`)
    }
    if (Number.isFinite(declaredLength) && totalBytes() + declaredLength > maxTotalBytes) {
      throw new Error(`attachment storage exceeds ${maxTotalBytes} bytes`)
    }
    const path = join(attachment.path, relativePath)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, "wx", 0o600)
    let size = 0
    try {
      for await (const chunk of readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > maxFileBytes) throw new Error(`attachment exceeds ${maxFileBytes} bytes`)
        if (totalBytes() + size > maxTotalBytes) {
          throw new Error(`attachment storage exceeds ${maxTotalBytes} bytes`)
        }
        await file.write(bytes)
      }
    } catch (error) {
      await file.close().catch(() => {})
      await rm(path, { force: true })
      throw error
    }
    await file.close()
    attachment.size += size
    attachment.fileCount += 1
    return publicAttachment(attachment)
  }

  async function importFolder(sourcePath) {
    if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
      throw new Error("selected folder path must be absolute")
    }
    const sourceMetadata = await lstat(sourcePath)
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
      throw new Error("selected path must be a directory")
    }

    const folder = await createFolder({ name: basename(sourcePath) })
    const attachment = attachments.get(folder.id)
    const copyDirectory = async (directoryPath, relativeDirectory = "") => {
      const entries = await readdir(directoryPath, { withFileTypes: true })
      if (relativeDirectory) {
        await mkdir(join(attachment.path, relativeDirectory), { recursive: true, mode: 0o700 })
      }
      for (const entry of entries) {
        const sourceEntry = join(directoryPath, entry.name)
        const relativeEntry = join(relativeDirectory, entry.name)
        if (entry.isSymbolicLink()) {
          throw new Error(`folder attachments cannot contain symbolic links: ${relativeEntry}`)
        }
        if (entry.isDirectory()) {
          await copyDirectory(sourceEntry, relativeEntry)
          continue
        }
        if (!entry.isFile()) {
          throw new Error(`folder attachments cannot contain special files: ${relativeEntry}`)
        }
        const metadata = await stat(sourceEntry)
        await uploadFolderFile(folder.id, createReadStream(sourceEntry), {
          relativePath: encodeURIComponent(
            `${attachment.name}/${relativeEntry.replaceAll("\\", "/")}`
          ),
          contentLength: metadata.size,
        })
      }
    }

    try {
      await copyDirectory(sourcePath)
      return publicAttachment(attachment)
    } catch (error) {
      await remove(folder.id)
      throw error
    }
  }

  function list() {
    return [...attachments.values()].map(publicAttachment)
  }

  function resolveIds(ids) {
    if (!Array.isArray(ids)) throw new Error("attachmentIds must be an array")
    if (ids.length > maxFiles) throw new Error(`attachment limit is ${maxFiles} files`)
    const unique = [...new Set(ids)]
    return unique.map((id) => {
      if (typeof id !== "string") throw new Error("attachment id is invalid")
      const attachment = attachments.get(id)
      if (!attachment) throw new Error(`attachment not found: ${id}`)
      return attachment
    })
  }

  async function remove(id) {
    const attachment = attachments.get(id)
    if (!attachment) return false
    attachments.delete(id)
    await rm(join(root, id), { recursive: true, force: true })
    return true
  }

  async function cleanup() {
    attachments.clear()
    await rm(root, { recursive: true, force: true })
  }

  return {
    root,
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    maxFolderFiles,
    initialize,
    upload,
    createFolder,
    uploadFolderFile,
    importFolder,
    list,
    resolveIds,
    remove,
    cleanup,
  }
}
