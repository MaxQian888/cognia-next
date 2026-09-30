/**
 * Files the renderer writes into the app's AppData directory on the desktop.
 *
 * AppData is the one tree the main window may write through
 * `@tauri-apps/plugin-fs` (`fs:allow-appdata-write-recursive` in
 * `src-tauri/capabilities/desktop.json`), so a feature that has bytes in the
 * webview and needs them as a path on disk (for FFmpeg, or for a later
 * workflow step) stages them here instead of widening the fs scope.
 *
 * Writes are chunked appends: a single `write_file` call would carry the whole
 * body as one IPC payload, and these files are videos of up to hundreds of MB.
 * They go to a `.part` file that is renamed into place once complete, so a
 * path that exists always holds a whole file: a crash mid-write, or two
 * windows writing the same path, never leave a truncated one behind.
 */

/** Chunk size of the append-write copy. */
export const APP_DATA_WRITE_CHUNK_BYTES = 8 * 1024 * 1024

/** A path relative to AppData made of plain segments; nothing that climbs out. */
function assertRelative(relativePath: string): void {
  const segments = relativePath.split("/")
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Not a relative AppData path: ${relativePath}`)
  }
}

function partSuffix(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Copy `blob` to `relativePath` under AppData, creating its directory, and
 * return the absolute path. An existing file at the path is replaced. A failed
 * copy removes its partial file and leaves the path as it was.
 */
export async function writeBlobToAppData(relativePath: string, blob: Blob): Promise<string> {
  assertRelative(relativePath)
  const [{ BaseDirectory, mkdir, remove, rename, writeFile }, { appDataDir, join }] =
    await Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")])
  const directory = relativePath.split("/").slice(0, -1).join("/")
  if (directory) await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true })
  const part = `${relativePath}.${partSuffix()}.part`
  try {
    for (let offset = 0; offset < blob.size || offset === 0; offset += APP_DATA_WRITE_CHUNK_BYTES) {
      const chunk = new Uint8Array(
        await blob.slice(offset, offset + APP_DATA_WRITE_CHUNK_BYTES).arrayBuffer()
      )
      await writeFile(part, chunk, { baseDir: BaseDirectory.AppData, append: offset > 0 })
      if (blob.size === 0) break
    }
    await rename(part, relativePath, {
      oldPathBaseDir: BaseDirectory.AppData,
      newPathBaseDir: BaseDirectory.AppData,
    })
  } catch (error) {
    await remove(part, { baseDir: BaseDirectory.AppData }).catch(() => {})
    throw error
  }
  return join(await appDataDir(), relativePath)
}

/**
 * Remove a file under AppData. A file that is already gone is not an error;
 * any other failure (a file held open elsewhere, a permission) throws, so a
 * caller that must not lose track of the file can keep its record.
 */
export async function removeAppDataFile(relativePath: string): Promise<void> {
  assertRelative(relativePath)
  const { BaseDirectory, exists, remove } = await import("@tauri-apps/plugin-fs")
  if (!(await exists(relativePath, { baseDir: BaseDirectory.AppData }))) return
  await remove(relativePath, { baseDir: BaseDirectory.AppData })
}

/**
 * Remove a directory under AppData with everything in it. A directory that is
 * already gone is not an error; any other failure throws.
 */
export async function removeAppDataDirectory(relativePath: string): Promise<void> {
  assertRelative(relativePath)
  const { BaseDirectory, exists, remove } = await import("@tauri-apps/plugin-fs")
  if (!(await exists(relativePath, { baseDir: BaseDirectory.AppData }))) return
  await remove(relativePath, { baseDir: BaseDirectory.AppData, recursive: true })
}

/** One entry of an AppData directory. */
export interface AppDataEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

/** The entries of a directory under AppData; none when it does not exist. */
export async function listAppDataDirectory(relativePath: string): Promise<AppDataEntry[]> {
  assertRelative(relativePath)
  const { BaseDirectory, exists, readDir } = await import("@tauri-apps/plugin-fs")
  if (!(await exists(relativePath, { baseDir: BaseDirectory.AppData }))) return []
  const entries = await readDir(relativePath, { baseDir: BaseDirectory.AppData })
  return entries.map(({ name, isDirectory, isFile }) => ({ name, isDirectory, isFile }))
}

/** When a file under AppData was last modified, or null when the disk does not say. */
export async function appDataModifiedAt(relativePath: string): Promise<number | null> {
  assertRelative(relativePath)
  const { BaseDirectory, stat } = await import("@tauri-apps/plugin-fs")
  const info = await stat(relativePath, { baseDir: BaseDirectory.AppData })
  return info.mtime ? info.mtime.getTime() : null
}

/** Whether a file exists under AppData. */
export async function appDataFileExists(relativePath: string): Promise<boolean> {
  assertRelative(relativePath)
  const { BaseDirectory, exists } = await import("@tauri-apps/plugin-fs")
  return exists(relativePath, { baseDir: BaseDirectory.AppData }).catch(() => false)
}

/** Read a file under AppData. */
export async function readAppDataFile(relativePath: string): Promise<Uint8Array> {
  assertRelative(relativePath)
  const { BaseDirectory, readFile } = await import("@tauri-apps/plugin-fs")
  return readFile(relativePath, { baseDir: BaseDirectory.AppData })
}

/** The absolute path of a file under AppData, without touching the disk. */
export async function appDataPath(relativePath: string): Promise<string> {
  assertRelative(relativePath)
  const { appDataDir, join } = await import("@tauri-apps/api/path")
  return join(await appDataDir(), relativePath)
}
