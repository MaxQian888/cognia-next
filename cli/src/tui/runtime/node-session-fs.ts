/**
 * Node-native {@link SessionFs} for the standalone CLI. The desktop's
 * `realSessionFs` routes through Tauri `plugin-fs` (or web `fetch`), neither of
 * which exists in the standalone Node process — so the CLI injects this into
 * `resolveScanInput({ fs })` to let the session-import adapters walk
 * `~/.claude/projects`, `~/.codex/sessions`, etc. straight off disk.
 *
 * Also supplies the vendor roots: the desktop reads `$CODEX_HOME` & friends in
 * Rust (`agent_vendor_roots`), which the CLI can't call — but it has the real
 * `process.env` right here.
 */
import { promises as fsp } from "node:fs"

import { vendorRootsFromEnv, type VendorRoots } from "@/lib/agent-roots"
import type { SessionFs } from "@/lib/session-import"

/** Bound bytes before UTF-8 decoding and JSON expansion in the vendor adapters. */
export const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024

export class SessionReadLimitError extends Error {
  constructor(readonly reason: "file" | "budget") {
    super(
      reason === "file"
        ? "Session file exceeds the 16 MiB read limit"
        : "Session analysis byte budget exhausted"
    )
    this.name = "SessionReadLimitError"
  }
}

export function nodeSessionFs(
  options: {
    /** Optional aggregate input budget for callers retaining parsed conversations. */
    maxTotalBytes?: number
    onLimit?: (reason: "file" | "budget") => void
  } = {}
): SessionFs {
  let remaining = options.maxTotalBytes ?? Infinity
  function rejectLimit(reason: "file" | "budget"): never {
    options.onLimit?.(reason)
    throw new SessionReadLimitError(reason)
  }
  return {
    async exists(path) {
      try {
        await fsp.access(path)
        return true
      } catch {
        return false
      }
    },
    async readDir(path) {
      // Basenames only — the adapters join them onto `dir` themselves.
      return fsp.readdir(path)
    },
    async stat(path) {
      const s = await fsp.stat(path)
      return { size: s.size, isFile: s.isFile() }
    },
    async readTextFile(path) {
      const handle = await fsp.open(path, "r")
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error("Session path is not a regular file")
        if (info.size > MAX_SESSION_FILE_BYTES) rejectLimit("file")
        if (info.size > remaining) rejectLimit("budget")
        // Reserve before awaiting any reads so concurrent readers share one budget.
        let reserved = info.size
        remaining -= reserved
        let used = 0
        const chunks: Buffer[] = []
        try {
          while (true) {
            // Read the reservation first. Growth is charged by actual bytes read,
            // with at most one bounded chunk in flight per descriptor. The
            // extra byte distinguishes EOF from growth at an exhausted limit.
            const available = reserved - used
            const chunk = Buffer.allocUnsafe(
              available > 0
                ? Math.min(64 * 1024, available)
                : Math.min(64 * 1024, MAX_SESSION_FILE_BYTES - used + 1, remaining + 1)
            )
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
            if (bytesRead === 0) break
            used += bytesRead
            // An appending transcript can outgrow the descriptor's initial stat.
            if (used > MAX_SESSION_FILE_BYTES) rejectLimit("file")
            const growth = Math.max(0, used - reserved)
            if (growth > remaining) rejectLimit("budget")
            remaining -= growth
            reserved += growth
            chunks.push(chunk.subarray(0, bytesRead))
          }
          return Buffer.concat(chunks, used).toString("utf8")
        } finally {
          remaining += reserved - Math.min(used, reserved)
        }
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * Resolve the vendor roots from the CLI process' own environment, honouring
 * `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` / `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME`
 * exactly like `src-tauri/src/agents/paths.rs:vendor_roots` does on desktop.
 */
export function nodeVendorRoots(
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): VendorRoots {
  return vendorRootsFromEnv(
    home,
    {
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: env.CODEX_HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      APPDATA: env.APPDATA,
    },
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
  )
}
