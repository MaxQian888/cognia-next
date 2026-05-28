// Thin compatibility layer that lets settings UIs read/write files in both
// Tauri (native dialogs + Rust file I/O) and the browser (input[type=file] +
// anchor download). Components import the *Async helpers and don't have to
// branch on `isTauri()` themselves.

import { isTauri } from "@/lib/tauri"
import { defaultExportDir, readTextFile, writeTextFile } from "@/lib/claude/ipc"
import { open, save } from "@tauri-apps/plugin-dialog"

export interface PickedFile {
  /** Filename only (basename), for fallback name derivation. */
  name: string
  /** Full path when running in Tauri. Empty in the browser. */
  path: string
  content: string
}

export interface PickFilesOptions {
  /** Tauri save/open filter spec (e.g. [{ name: "Markdown", extensions: ["md"] }]). */
  filters?: { name: string; extensions: string[] }[]
  /** Allow selecting more than one file. */
  multiple?: boolean
}

/**
 * Open a file picker and return the selected files' contents. Works in
 * Tauri (native dialog + Rust read) and the browser (hidden input element).
 * Returns an empty array if the user cancels.
 */
export async function pickAndReadFiles(opts: PickFilesOptions = {}): Promise<PickedFile[]> {
  if (isTauri()) {
    const picked = await open({
      multiple: !!opts.multiple,
      directory: false,
      filters: opts.filters,
    })
    if (!picked) return []
    const paths = Array.isArray(picked) ? picked : [picked]
    const out: PickedFile[] = []
    for (const path of paths) {
      try {
        const content = await readTextFile(path)
        out.push({ name: basename(path), path, content })
      } catch (err) {
        console.error("read file failed", path, err)
      }
    }
    return out
  }
  // Browser fallback: hidden file input.
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = !!opts.multiple
    if (opts.filters?.length) {
      input.accept = opts.filters.flatMap((f) => f.extensions.map((e) => "." + e)).join(",")
    }
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        resolve([])
        return
      }
      const files = Array.from(input.files)
      const out: PickedFile[] = []
      for (const f of files) {
        const content = await f.text()
        out.push({ name: f.name, path: "", content })
      }
      resolve(out)
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

export interface SaveFileOptions {
  /** Default filename suggested in the save dialog (e.g. "my-skill.md"). */
  defaultName: string
  content: string
  /** Tauri save filter spec. */
  filters?: { name: string; extensions: string[] }[]
}

/**
 * Save a file's contents to disk. In Tauri shows a native save dialog and
 * writes through the Rust file commands. In the browser, triggers a download
 * via a hidden anchor. Returns true on success, false if user cancelled.
 */
export async function saveFileAs(opts: SaveFileOptions): Promise<boolean> {
  if (isTauri()) {
    let defaultPath = opts.defaultName
    try {
      const dir = await defaultExportDir()
      defaultPath = `${dir}/${opts.defaultName}`
    } catch {
      // Fallback to bare filename — Tauri shows it in the user's last-used dir.
    }
    const chosen = await save({
      defaultPath,
      filters: opts.filters,
    })
    if (!chosen) return false
    await writeTextFile(chosen, opts.content)
    return true
  }
  // Browser fallback: trigger a download.
  const blob = new Blob([opts.content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = opts.defaultName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

/** Pick a directory (Tauri only). Returns null if the user cancels or web. */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null
  const picked = await open({ directory: true, multiple: false })
  if (!picked) return null
  return Array.isArray(picked) ? (picked[0] ?? null) : picked
}

export interface PickedBinaryFile {
  /** Filename only (basename), for fallback name derivation. */
  name: string
  /** Full path when running in Tauri. Empty in the browser. */
  path: string
  bytes: Uint8Array
}

/**
 * Open a file picker and return each selected file as raw bytes. Use this
 * sibling of `pickAndReadFiles` for zip / image / archive imports that
 * can't ride on the utf-8 text path.
 *
 * Tauri uses the native dialog + the `@tauri-apps/plugin-fs` readFile
 * binding (no new Rust command). Browser and Capacitor webviews fall back
 * to a hidden `<input type="file">` plus `f.arrayBuffer()` — the same
 * pattern works on both because Capacitor injects only its native bridge
 * shim and not the file-picker plugin (see memory:
 * `project_capacitor_plugins_unregistered_on_device`).
 */
export async function pickAndReadBinaryFiles(
  opts: PickFilesOptions = {}
): Promise<PickedBinaryFile[]> {
  if (isTauri()) {
    const picked = await open({
      multiple: !!opts.multiple,
      directory: false,
      filters: opts.filters,
    })
    if (!picked) return []
    const paths = Array.isArray(picked) ? picked : [picked]
    const fs = await import("@tauri-apps/plugin-fs")
    const out: PickedBinaryFile[] = []
    for (const path of paths) {
      try {
        const bytes = await fs.readFile(path)
        out.push({ name: basename(path), path, bytes })
      } catch (err) {
        console.error("read binary file failed", path, err)
      }
    }
    return out
  }
  return new Promise<PickedBinaryFile[]>((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = !!opts.multiple
    if (opts.filters?.length) {
      input.accept = opts.filters.flatMap((f) => f.extensions.map((e) => "." + e)).join(",")
    }
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        resolve([])
        return
      }
      const files = Array.from(input.files)
      const out: PickedBinaryFile[] = []
      for (const f of files) {
        const buf = await f.arrayBuffer()
        out.push({ name: f.name, path: "", bytes: new Uint8Array(buf) })
      }
      resolve(out)
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

/**
 * Write multiple files into a directory. In Tauri, writes them under
 * `dir/<filename>` directly. In the browser falls back to one download per
 * file.
 */
export async function saveFilesToDir(
  dir: string | null,
  files: { name: string; content: string }[]
): Promise<{ writtenCount: number; errored: Array<{ name: string; error: string }> }> {
  const result = { writtenCount: 0, errored: [] as Array<{ name: string; error: string }> }
  if (isTauri() && dir) {
    for (const f of files) {
      try {
        await writeTextFile(`${dir}/${f.name}`, f.content)
        result.writtenCount += 1
      } catch (err) {
        result.errored.push({
          name: f.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return result
  }
  // Browser fallback: trigger a sequence of downloads.
  for (const f of files) {
    try {
      await saveFileAs({ defaultName: f.name, content: f.content })
      result.writtenCount += 1
    } catch (err) {
      result.errored.push({
        name: f.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

function basename(path: string): string {
  // Handle both / and \ separators.
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx === -1 ? path : path.slice(idx + 1)
}
