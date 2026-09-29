import fs from "node:fs/promises"
import path from "node:path"

import { RemoteBrowserError } from "./browser-errors.mjs"

const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"]
const MAX_COLLISION_SUFFIX = 9999

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Reduce a server-suggested download name to one safe path segment. Chromium
 * already sanitizes `suggestedFilename`, but the runtime never trusts it: path
 * separators, NUL, control characters, and Windows-reserved characters are
 * replaced, and names that would resolve to `.`/`..` fall back to `download`.
 */
export function safeFilename(value, fallback = "download") {
  const base = path.basename(String(value ?? "").replace(/\\/g, "/"))
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return cleaned.slice(0, 200)
}

export function splitExtension(filename) {
  const lower = filename.toLowerCase()
  const compound = COMPOUND_EXTENSIONS.find(
    (extension) => lower.endsWith(extension) && lower.length > extension.length
  )
  if (compound) {
    return {
      stem: filename.slice(0, filename.length - compound.length),
      extension: filename.slice(filename.length - compound.length),
    }
  }
  const extension = path.extname(filename)
  if (!extension || extension === filename) return { stem: filename, extension: "" }
  return { stem: filename.slice(0, filename.length - extension.length), extension }
}

/**
 * Atomically reserve `dir/filename`, or `dir/name (1).ext`, `dir/name (2).ext`…
 * when taken. The empty placeholder is created with `wx`, so two concurrent
 * downloads with the same suggested name can never pick the same path; the
 * caller overwrites the placeholder with the real bytes.
 */
export async function reserveUniquePath(dir, filename) {
  await fs.mkdir(dir, { recursive: true })
  const safe = safeFilename(filename)
  const { stem, extension } = splitExtension(safe)
  for (let attempt = 0; attempt <= MAX_COLLISION_SUFFIX; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? safe : `${stem} (${attempt})${extension}`)
    try {
      const handle = await fs.open(candidate, "wx", 0o600)
      await handle.close()
      return candidate
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
  }
  throw new RemoteBrowserError(
    "browser_download_name_exhausted",
    "No free download filename is available"
  )
}

function hasHiddenSegment(relative) {
  if (!relative) return false
  return relative.split(/[\\/]+/).some((segment) => segment.startsWith("."))
}

/**
 * The requested path relative to whichever configured (or resolved) root it
 * was written under, before symlinks are followed. Returns the basename when
 * it sits under none, so a hidden final segment is still caught.
 */
function requestedRelative(candidate, uploadRoots, realRoots) {
  const normalized = path.normalize(candidate)
  for (const root of [...uploadRoots, ...realRoots]) {
    if (isWithin(path.normalize(root), normalized)) {
      return path.relative(path.normalize(root), normalized)
    }
  }
  return path.basename(normalized)
}

/**
 * Local-mode uploads accept absolute paths only inside the session's
 * `uploadRoots` (after resolving symlinks on both sides with `realpath`),
 * never a dotfile or a file inside a dot-directory. With no roots the session
 * has no upload capability at all.
 */
export async function resolveLocalUploads(
  paths,
  uploadRoots,
  { maxFiles = 10, maxFileBytes = 100 * 1024 * 1024 } = {}
) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new RemoteBrowserError("browser_upload_invalid", "Upload paths are required")
  }
  if (paths.length > maxFiles) {
    throw new RemoteBrowserError("browser_upload_invalid", "Too many upload files")
  }
  if (!Array.isArray(uploadRoots) || uploadRoots.length === 0) {
    throw new RemoteBrowserError(
      "browser_upload_path_denied",
      "This browser session has no upload roots"
    )
  }
  const realRoots = []
  for (const root of uploadRoots) {
    try {
      realRoots.push(await fs.realpath(root))
    } catch {
      // A root that no longer exists grants nothing.
    }
  }
  const resolved = []
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new RemoteBrowserError("browser_upload_path_denied", "Upload paths must be absolute")
    }
    let real
    try {
      real = await fs.realpath(candidate)
    } catch {
      throw new RemoteBrowserError("browser_upload_not_found", "Upload file does not exist")
    }
    const root = realRoots.find((candidateRoot) => isWithin(candidateRoot, real))
    if (!root) {
      throw new RemoteBrowserError(
        "browser_upload_path_denied",
        "Upload path is outside the allowed roots"
      )
    }
    // Dotfiles and anything under a dot-directory (`.ssh`, `.aws`, `.env`…)
    // are never uploadable, whether named directly or reached via a symlink:
    // both the requested path (below its root) and the resolved path are checked.
    if (
      hasHiddenSegment(path.relative(root, real)) ||
      hasHiddenSegment(requestedRelative(candidate, uploadRoots, realRoots))
    ) {
      throw new RemoteBrowserError(
        "browser_upload_path_denied",
        "Hidden files and directories cannot be uploaded"
      )
    }
    const stat = await fs.stat(real)
    if (!stat.isFile()) {
      throw new RemoteBrowserError("browser_upload_invalid", "Upload path is not a file")
    }
    if (stat.size > maxFileBytes) {
      throw new RemoteBrowserError("browser_upload_too_large", "Upload file is too large")
    }
    resolved.push(real)
  }
  return resolved
}
