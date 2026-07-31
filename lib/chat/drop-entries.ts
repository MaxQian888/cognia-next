/**
 * Generic drag-drop resolution for the chat composer.
 *
 * A drop can carry plain files, whole directories, or a mix of both. The
 * renderer owns drag-drop (`dragDropEnabled: false` in `tauri.conf.json`), so a
 * dropped directory carries no absolute path and cannot become a
 * `referencedPaths` entry the way the attach menu's native folder picker does.
 * Instead we walk it with the non-standard `webkitGetAsEntry` API (the same
 * shape `components/settings/pet/pet-model-import.ts` relies on) and hand the
 * contained files to the exact attachment gate every other drop goes through —
 * size / type / count limits stay single-source.
 */

/** Hard cap on files pulled out of a dropped directory tree. */
export const MAX_DROPPED_DIR_FILES = 200

export interface DroppedFiles {
  /** Flattened files; directory members are named by their relative path. */
  files: File[]
  /** Number of top-level directories that were walked. */
  directories: number
  /** True when the walk stopped at {@link MAX_DROPPED_DIR_FILES}. */
  truncated: boolean
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
}

interface FileEntryLike extends EntryLike {
  file(onSuccess: (file: File) => void, onError?: (err: unknown) => void): void
}

interface DirectoryEntryLike extends EntryLike {
  createReader(): {
    readEntries(onSuccess: (entries: EntryLike[]) => void, onError?: (err: unknown) => void): void
  }
}

function readFile(entry: FileEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null)
    )
  })
}

/**
 * `readEntries` returns at most one batch per call and signals completion with
 * an empty batch, so it must be drained in a loop.
 */
function readEntries(entry: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader()
  return new Promise((resolve) => {
    const collected: EntryLike[] = []
    const next = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(collected)
            return
          }
          collected.push(...batch)
          next()
        },
        () => resolve(collected)
      )
    }
    next()
  })
}

/** Re-label a file with its path inside the dropped folder (`docs/readme.md`). */
function withRelativeName(file: File, relativePath: string): File {
  if (file.name === relativePath) return file
  return new File([file], relativePath, { type: file.type, lastModified: file.lastModified })
}

/**
 * Flatten a drop into files. Falls back to `dataTransfer.files` when the
 * browser exposes no entry API (or the drop carried no entries at all), which
 * keeps plain file drops working exactly as before.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFiles> {
  const plain = Array.from(dataTransfer.files ?? [])
  // `DataTransferItemList` is neutered once the drop handler returns, so every
  // entry has to be pulled out synchronously — before the first await.
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) =>
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as EntryLike | null)
        : null
    )
    .filter((entry): entry is EntryLike => entry !== null)

  if (entries.length === 0) return { files: plain, directories: 0, truncated: false }

  const files: File[] = []
  let directories = 0
  let truncated = false

  const walk = async (entry: EntryLike, prefix: string): Promise<void> => {
    if (files.length >= MAX_DROPPED_DIR_FILES) {
      truncated = true
      return
    }
    if (entry.isFile) {
      const file = await readFile(entry as FileEntryLike)
      if (file) files.push(withRelativeName(file, `${prefix}${entry.name}`))
      return
    }
    if (!entry.isDirectory) return
    const children = await readEntries(entry as DirectoryEntryLike)
    for (const child of children) {
      await walk(child, `${prefix}${entry.name}/`)
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory) directories += 1
    await walk(entry, "")
  }

  return { files, directories, truncated }
}
