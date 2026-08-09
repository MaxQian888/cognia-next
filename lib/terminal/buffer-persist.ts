/**
 * Buffer persistence — frontend orchestration layer.
 *
 * Coordinates the save/restore of terminal scrollback buffers across app
 * restarts. The actual byte storage is handled by Rust (Tauri commands);
 * this module exposes the frontend contract and fallback logic.
 *
 * Flow:
 *  - On session close / app exit: `dumpBuffer(sessionId)` → Tauri saves
 *    the replay buffer to disk (zstd compressed).
 *  - On session reattach: `loadBuffer(sessionId)` → Tauri reads the saved
 *    buffer, which the terminal instance writes into xterm.
 *  - On startup: `pruneBuffers()` removes files older than 7 days.
 *
 * When running in browser/mobile (non-Tauri), all operations are no-ops.
 */

import { isTauri } from "@/lib/tauri"

/** Maximum lines per persisted buffer. */
export const MAX_BUFFER_LINES = 50_000

/** Maximum buffer file size in bytes (10 MB). */
export const MAX_BUFFER_SIZE_BYTES = 10 * 1024 * 1024

/** Maximum age for stored buffers (7 days). */
export const MAX_BUFFER_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Result of a buffer load operation. */
export interface BufferLoadResult {
  /** Whether a buffer was found and loaded. */
  found: boolean
  /** The raw buffer content (terminal output bytes). Null if not found. */
  content: string | null
  /** Number of lines in the restored buffer. */
  lineCount: number
}

/** Result of a buffer dump operation. */
export interface BufferDumpResult {
  /** Whether the dump was successful. */
  success: boolean
  /** Size of the saved buffer in bytes. */
  sizeBytes: number
  /** Error message if not successful. */
  error?: string
}

/** Result of a prune operation. */
export interface BufferPruneResult {
  /** Number of buffer files removed. */
  removedCount: number
  /** Total bytes freed. */
  freedBytes: number
}

/**
 * Dump the current replay buffer for a session to disk.
 * Called on session close or app exit.
 *
 * @param sessionId - The terminal session id
 * @param content - The scrollback content to persist
 * @returns Result indicating success/failure
 */
export async function dumpBuffer(sessionId: string, content: string): Promise<BufferDumpResult> {
  if (!isTauri()) {
    return { success: false, sizeBytes: 0, error: "Not running in Tauri" }
  }

  // Guard: don't persist empty buffers
  if (!content || content.length === 0) {
    return { success: false, sizeBytes: 0, error: "Empty buffer" }
  }

  // Guard: cap at MAX_BUFFER_SIZE_BYTES
  const truncated =
    content.length > MAX_BUFFER_SIZE_BYTES ? content.slice(-MAX_BUFFER_SIZE_BYTES) : content

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<{ size_bytes: number }>("terminal_dump_buffer", {
      sessionId,
      content: truncated,
    })
    return { success: true, sizeBytes: result.size_bytes }
  } catch (err) {
    return {
      success: false,
      sizeBytes: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Load a previously persisted buffer for a session.
 * Called when a session is reattached after an app restart.
 *
 * @param sessionId - The terminal session id
 * @returns The buffer content, or null if not found
 */
export async function loadBuffer(sessionId: string): Promise<BufferLoadResult> {
  if (!isTauri()) {
    return { found: false, content: null, lineCount: 0 }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<{ found: boolean; content: string | null }>(
      "terminal_load_buffer",
      { sessionId }
    )

    if (!result.found || !result.content) {
      return { found: false, content: null, lineCount: 0 }
    }

    const lineCount = result.content.split("\n").length
    return { found: true, content: result.content, lineCount }
  } catch {
    return { found: false, content: null, lineCount: 0 }
  }
}

/**
 * Prune old buffer files (older than 7 days).
 * Called on app startup.
 *
 * @returns Count and size of removed files
 */
export async function pruneBuffers(): Promise<BufferPruneResult> {
  if (!isTauri()) {
    return { removedCount: 0, freedBytes: 0 }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<{ removed_count: number; freed_bytes: number }>(
      "terminal_prune_buffers"
    )
    return { removedCount: result.removed_count, freedBytes: result.freed_bytes }
  } catch {
    return { removedCount: 0, freedBytes: 0 }
  }
}

/**
 * Check if a buffer exists for a session without loading it.
 * Useful for showing a "restore" indicator in the UI.
 */
export async function hasPersistedBuffer(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<boolean>("terminal_has_buffer", { sessionId })
  } catch {
    return false
  }
}
