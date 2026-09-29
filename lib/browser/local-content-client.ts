/**
 * Local files and dev servers for the browser pane (ADR-0201,
 * `src-tauri/src/browser/local_content.rs`).
 *
 * A local file or directory is served by a Rust loopback static server under a
 * random 128-bit path prefix, so relative assets resolve and the page lands in
 * the trusted (`localhost`) tier instead of a `file://` origin the embedded
 * webview cannot script.
 */
import { transport } from "@/lib/tauri"

export interface LocalFileServe {
  /** URL of the served file (or the directory's index/listing). */
  url: string
  /** Opaque root handle; pass to `stopLocalFile` to stop serving it. */
  root: string
}

export interface DevServer {
  url: string
  port: number
  pid: number | null
  process: string | null
  title: string | null
}

export function serveLocalFile(path: string): Promise<LocalFileServe> {
  return transport.call<LocalFileServe>("browser_local_file_serve", { path })
}

export function stopLocalFile(root: string): Promise<void> {
  return transport.call<void>("browser_local_file_stop", { root })
}

export function detectDevServers(): Promise<DevServer[]> {
  return transport.call<DevServer[]>("browser_dev_servers_detect")
}

/**
 * What the address bar typed, when it names a local file: an absolute POSIX
 * path, a Windows drive path, a UNC path, a `~/` path or a `file://` URL.
 * Returns the filesystem path to serve, or null when it is not a local path.
 */
export function localPathFromAddress(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (url.host && url.host !== "localhost")
        return `//${url.host}${decodeURIComponent(url.pathname)}`
      const path = decodeURIComponent(url.pathname)
      // file:///C:/x → C:/x
      return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path
    } catch {
      return null
    }
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed
  if (trimmed.startsWith("~/")) return trimmed
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed
  if (/^\\\\[^\\]+\\/.test(trimmed)) return trimmed
  return null
}
