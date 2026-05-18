"use client"

import { upload as uploadNative, download as downloadNative } from "@tauri-apps/plugin-upload"
import { isTauri } from "@/lib/tauri"

// `@tauri-apps/plugin-upload@2.4.0` keeps both `ProgressPayload` and
// `ProgressHandler` internal — mirror their shape here so callers can name
// the payload and the callback without reaching into plugin internals.
export type UploadProgress = {
  progress: number
  progressTotal: number
  total: number
  transferSpeed: number
}
export type UploadProgressCallback = (progress: UploadProgress) => void

export interface UploadOptions {
  headers?: Map<string, string> | Record<string, string>
  onProgress?: UploadProgressCallback
}

function normalizeHeaders(
  headers: Map<string, string> | Record<string, string> | undefined
): Map<string, string> | undefined {
  if (!headers) return undefined
  if (headers instanceof Map) return headers
  return new Map(Object.entries(headers))
}

/**
 * Upload a local file to `url` via the Tauri upload plugin, streaming
 * progress events to `onProgress` when provided. Returns the response body
 * string on success, or `null` outside Tauri / on plugin failure.
 */
export async function uploadFile(
  url: string,
  filePath: string,
  options: UploadOptions = {}
): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return await uploadNative(url, filePath, options.onProgress, normalizeHeaders(options.headers))
  } catch (err) {
    console.warn("uploadFile failed", err)
    return null
  }
}

/**
 * Download a remote URL to `filePath` via the Tauri upload plugin. Returns
 * `true` on success, `false` outside Tauri / on plugin failure.
 */
export async function downloadFile(
  url: string,
  filePath: string,
  options: UploadOptions = {}
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await downloadNative(url, filePath, options.onProgress, normalizeHeaders(options.headers))
    return true
  } catch (err) {
    console.warn("downloadFile failed", err)
    return false
  }
}
