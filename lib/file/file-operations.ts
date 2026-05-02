/**
 * Cross-runtime file operations shared by plugin utilities.
 *
 * In Tauri builds, all file IO routes through `@tauri-apps/plugin-fs`.
 * In web mode the plugin runtime can't write to the user's filesystem;
 * read paths fall back to `fetch` (so plugin assets shipped under the
 * dev server still work) and write paths reject with a clear error.
 *
 * Plugin code is expected to gate write operations behind a permission
 * check before calling here.
 */

import { isTauri } from "@/lib/tauri"

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
