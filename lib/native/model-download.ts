/**
 * Stub: native (Tauri) model-download bindings.
 *
 * Cognia ships Rust commands to download / cancel / track local model
 * files (gguf for llama.cpp, ollama pulls, etc.). cognia-next defers
 * those Tauri commands per the provider port plan; this stub keeps the
 * UI compiling and reports "unavailable" at runtime so users see the
 * right error rather than a TypeError.
 */

export interface ModelDownloadProgress {
  modelId: string
  status: "pending" | "downloading" | "completed" | "error" | "cancelled"
  bytesDownloaded: number
  bytesTotal: number
  percentage: number
  digest?: string
  error?: string
}

export async function downloadModel(_args: { providerId: string; modelId: string }): Promise<void> {
  throw new Error("Native model downloads are not available yet in cognia-next.")
}

export async function cancelDownload(_args: {
  providerId: string
  modelId: string
}): Promise<void> {
  // No-op: nothing in flight.
}

export async function listDownloadProgress(): Promise<Record<string, ModelDownloadProgress>> {
  return {}
}

export function subscribeDownloadProgress(
  _handler: (progress: ModelDownloadProgress) => void
): () => void {
  return () => undefined
}
