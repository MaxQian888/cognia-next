import { pickAndReadBinaryFiles, saveBinaryFileAs } from "@/lib/files/file-bridge"
import type { PluginFileHandle, PluginFilesAPI } from "@/types/plugin"
import { createApiGuardedAPI } from "./api-permission-gate"

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const attachmentHandles = new Map<string, { pluginId: string; file: PluginFileHandle }>()
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

function newHandleId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `file_${Date.now()}_${Math.random().toString(36).slice(2)}`
  )
}

function normalizeAccept(accept: string[] | undefined) {
  const extensions = new Set(
    (accept ?? []).flatMap((entry) => {
      if (entry.startsWith(".")) return [entry.slice(1).toLowerCase()]
      return Object.entries(MIME_BY_EXTENSION)
        .filter(([, mimeType]) => mimeMatches(mimeType, entry))
        .map(([extension]) => extension)
    })
  )
  return extensions.size ? [{ name: "Accepted files", extensions: [...extensions] }] : undefined
}

function inferMime(name: string, accept: string[] | undefined): string {
  const detected = MIME_BY_EXTENSION[fileExtension(name)]
  if (detected) return detected
  const explicit = accept?.find((entry) => entry.includes("/") && !entry.endsWith("/*"))
  if (explicit) return explicit
  return "application/octet-stream"
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function mimeMatches(actual: string, accepted: string): boolean {
  if (!accepted.includes("/")) return false
  return accepted.endsWith("/*")
    ? actual.startsWith(accepted.slice(0, -1))
    : actual.toLowerCase() === accepted.toLowerCase()
}

function matchesAccept(name: string, accept: string[] | undefined): boolean {
  if (!accept?.length) return true
  const extension = fileExtension(name)
  const mimeType = MIME_BY_EXTENSION[extension]
  return accept.some((entry) => {
    if (entry.startsWith(".")) return extension === entry.slice(1).toLowerCase()
    return mimeType ? mimeMatches(mimeType, entry) : false
  })
}

/** Host seam for granting one plugin access to an already-authorized attachment. */
export function authorizePluginAttachment(
  pluginId: string,
  file: Omit<PluginFileHandle, "id"> & { id?: string }
): string {
  const handle = file.id ?? newHandleId()
  attachmentHandles.set(handle, { pluginId, file: { ...file, id: handle } })
  return handle
}

export function revokePluginFileHandles(pluginId: string): void {
  for (const [handle, entry] of attachmentHandles) {
    if (entry.pluginId === pluginId) attachmentHandles.delete(handle)
  }
}

export function createFilesAPI(pluginId: string): PluginFilesAPI {
  const api: PluginFilesAPI = {
    open: async (options = {}) => {
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error("files.open maxBytes must be a positive integer")
      }
      const selected = await pickAndReadBinaryFiles({
        multiple: options.multiple,
        filters: normalizeAccept(options.accept),
      })
      return selected.map((selectedFile) => {
        if (!matchesAccept(selectedFile.name, options.accept)) {
          throw new Error(`selected file does not match accepted types: ${selectedFile.name}`)
        }
        if (selectedFile.bytes.byteLength > maxBytes) {
          throw new Error(`selected file exceeds maxBytes: ${selectedFile.name}`)
        }
        const handle = authorizePluginAttachment(pluginId, {
          name: selectedFile.name,
          mimeType: inferMime(selectedFile.name, options.accept),
          size: selectedFile.bytes.byteLength,
          bytes: selectedFile.bytes,
        })
        return attachmentHandles.get(handle)!.file
      })
    },
    save: async ({ suggestedName, mimeType, bytes }) => {
      if (!suggestedName.trim() || suggestedName.includes("/") || suggestedName.includes("\\")) {
        throw new Error("files.save suggestedName must be a filename without a path")
      }
      if (!mimeType.includes("/")) throw new Error("files.save mimeType is invalid")
      return {
        saved: await saveBinaryFileAs({
          defaultName: suggestedName,
          mimeType,
          bytes,
          filters: normalizeAccept([`.${suggestedName.split(".").pop() ?? "bin"}`]),
        }),
      }
    },
    readAttachment: async (handle) => {
      const entry = attachmentHandles.get(handle)
      if (!entry || entry.pluginId !== pluginId) {
        throw new Error("attachment handle is not authorized for this plugin")
      }
      return entry.file
    },
  }

  return createApiGuardedAPI(
    pluginId,
    api,
    {
      open: "filesystem:read",
      readAttachment: "filesystem:read",
      save: "filesystem:write",
    },
    { unguarded: [] }
  )
}
