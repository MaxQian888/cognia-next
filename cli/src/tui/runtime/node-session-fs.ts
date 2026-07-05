/**
 * Node-native {@link SessionFs} for the standalone CLI. The desktop's
 * `realSessionFs` routes through Tauri `plugin-fs` (or web `fetch`), neither of
 * which exists in the standalone Node process — so the CLI injects this into
 * `resolveScanInput({ fs })` to let the session-import adapters walk
 * `~/.claude/projects`, `~/.codex/sessions`, etc. straight off disk.
 */
import { promises as fsp } from "node:fs"

import type { SessionFs } from "@/lib/session-import"

export function nodeSessionFs(): SessionFs {
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
      return fsp.readFile(path, "utf8")
    },
  }
}
