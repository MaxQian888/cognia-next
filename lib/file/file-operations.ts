/**
 * Cross-runtime file operations shared by plugin utilities.
 *
 * In Tauri builds, all file IO routes through `@tauri-apps/plugin-fs`.
 * In web mode the plugin runtime can't write to the user's filesystem;
 * read paths fall back to `fetch` (so plugin assets shipped under the
 * dev server still work) and write paths reject with a clear error.
 *
 * Plugin code is expected to gate write operations behind a permission
 * check before calling here — see `lib/files/permissions.ts` and the
 * `lib/files/secure-fs.ts` façade, which wraps these primitives with a policy
 * check, structured logging, and an audit trail.
 *
 * Beyond the original text helpers this module exposes binary read/write and
 * the structural operations (`removeFile`, `copyFile`, `renameFile`,
 * `createDir`, `statFile`). In Tauri they route through `@tauri-apps/plugin-fs`
 * like the rest of this file; in web mode read paths fall back to `fetch` where
 * meaningful and mutating paths reject with a clear error.
 */

import { isTauri } from "@/lib/tauri"
import type { FileStat } from "@/types/files"

export interface ReadOptions {
  /** Optional encoding hint; only utf-8 is supported today. */
  encoding?: "utf-8"
}

export async function readTextFile(path: string, _options: ReadOptions = {}): Promise<string> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    return fs.readTextFile(path)
  }
  // Web fallback: treat the path as relative to the dev server.
  if (typeof fetch === "function") {
    const res = await fetch(path)
    if (!res.ok) {
      throw new Error(`readTextFile: HTTP ${res.status} for ${path}`)
    }
    return res.text()
  }
  throw new Error("readTextFile: no runtime support outside of Tauri / browser")
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.writeTextFile(path, contents)
    return
  }
  throw new Error("writeTextFile: not supported in web mode")
}

export async function exists(path: string): Promise<boolean> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    return fs.exists(path)
  }
  if (typeof fetch === "function") {
    try {
      const res = await fetch(path, { method: "HEAD" })
      return res.ok
    } catch {
      return false
    }
  }
  return false
}

export async function readDir(path: string): Promise<string[]> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    const entries = await fs.readDir(path)
    return entries.map((entry) => entry.name).filter((n): n is string => typeof n === "string")
  }
  return []
}

/**
 * Read a file as raw bytes. Tauri uses the `plugin-fs` `readFile` binding; the
 * web fallback fetches the path (relative to the dev server) and returns its
 * bytes. Throws when no runtime can satisfy the read.
 */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    return fs.readFile(path)
  }
  if (typeof fetch === "function") {
    const res = await fetch(path)
    if (!res.ok) {
      throw new Error(`readBinaryFile: HTTP ${res.status} for ${path}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
  throw new Error("readBinaryFile: no runtime support outside of Tauri / browser")
}

/** Write raw bytes to a file. Tauri-only — web mode cannot write to disk. */
export async function writeBinaryFile(path: string, data: Uint8Array): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.writeFile(path, data)
    return
  }
  throw new Error("writeBinaryFile: not supported in web mode")
}

/**
 * Remove a file or directory. Pass `recursive` to delete a non-empty
 * directory. Tauri-only.
 */
export async function removeFile(
  path: string,
  options: { recursive?: boolean } = {}
): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.remove(path, { recursive: options.recursive ?? false })
    return
  }
  throw new Error("removeFile: not supported in web mode")
}

/** Copy a file from `fromPath` to `toPath`. Tauri-only. */
export async function copyFile(fromPath: string, toPath: string): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.copyFile(fromPath, toPath)
    return
  }
  throw new Error("copyFile: not supported in web mode")
}

/** Move / rename a file or directory. Tauri-only. */
export async function renameFile(fromPath: string, toPath: string): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.rename(fromPath, toPath)
    return
  }
  throw new Error("renameFile: not supported in web mode")
}

/**
 * Create a directory. Defaults to recursive (mkdir -p) so parent directories
 * are created as needed — matching `ensureDir` in `lib/claude/ipc.ts`.
 * Tauri-only.
 */
export async function createDir(
  path: string,
  options: { recursive?: boolean } = {}
): Promise<void> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    await fs.mkdir(path, { recursive: options.recursive ?? true })
    return
  }
  throw new Error("createDir: not supported in web mode")
}

/**
 * Stat a path, returning normalized metadata. Tauri uses `plugin-fs` `stat`;
 * the web fallback issues a `HEAD` request and derives size from the
 * `Content-Length` header (treating the target as a file). Throws when the path
 * cannot be stat'd.
 */
export async function statFile(path: string): Promise<FileStat> {
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs")
    const info = await fs.stat(path)
    return {
      path,
      size: info.size,
      isFile: info.isFile,
      isDir: info.isDirectory,
      isSymlink: info.isSymlink,
      modifiedMs: info.mtime ? info.mtime.getTime() : undefined,
      createdMs: info.birthtime ? info.birthtime.getTime() : undefined,
      readonly: info.readonly,
    }
  }
  if (typeof fetch === "function") {
    const res = await fetch(path, { method: "HEAD" })
    if (!res.ok) {
      throw new Error(`statFile: HTTP ${res.status} for ${path}`)
    }
    const len = res.headers.get("content-length")
    return {
      path,
      size: len ? Number(len) : 0,
      isFile: true,
      isDir: false,
    }
  }
  throw new Error("statFile: no runtime support outside of Tauri / browser")
}
