/**
 * Renderer-side wrapper around the `download_cognia_cli` Tauri command
 * (`src-tauri/src/cli_bridge/download.rs`). Drives the prebuilt-download
 * tab of the CLI install dialog: kicks off the download, relays progress
 * events to a callback, and resolves with the install receipt.
 *
 * Tauri-only — on web / Capacitor there's no release to fetch and no FS
 * to extract into, so the caller gates the UI with `isTauri()`.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import { isTauri } from "@/lib/tauri"

export interface DownloadProgress {
  stage: "downloading" | "verifying" | "extracting" | "done" | string
  /** 0.0–1.0 during the download stage; null for discrete stages. */
  progress: number | null
  message: string
}

export interface DownloadResult {
  version: string
  installDir: string
  binaryPath: string
  signatureVerified: boolean
}

export interface DownloadOptions {
  /** GitHub release tag (defaults to "latest" on the native side). */
  releaseTag?: string
  /** Override the GitHub repo (defaults to the canonical repo). */
  repo?: string
  /** Override the install root (the user's chosen download location). */
  targetDir?: string
  /** Progress callback fired on each `download_cognia_cli_progress` event. */
  onProgress?: (p: DownloadProgress) => void
}

/**
 * Download, verify, and install the `cognia` CLI. Resolves with the
 * receipt on success; rejects with the native error string on failure
 * (checksum mismatch, signature failure, unsupported platform, …).
 */
export async function downloadCogniaCli(options: DownloadOptions = {}): Promise<DownloadResult> {
  if (!isTauri()) {
    throw new Error("Downloading the cognia CLI requires the desktop app.")
  }
  const { onProgress } = options
  let unlisten: (() => void) | null = null
  if (onProgress) {
    unlisten = await listen<DownloadProgress>("download_cognia_cli_progress", (event) => {
      if (event.payload) onProgress(event.payload)
    })
  }
  try {
    const result = await invoke<{
      version: string
      installDir: string
      binaryPath: string
      signatureVerified: boolean
    }>("download_cognia_cli", {
      releaseTag: options.releaseTag ?? null,
      repo: options.repo ?? null,
      targetDir: options.targetDir ?? null,
    })
    return {
      version: result.version,
      installDir: result.installDir,
      binaryPath: result.binaryPath,
      signatureVerified: Boolean(result.signatureVerified),
    }
  } finally {
    unlisten?.()
  }
}
