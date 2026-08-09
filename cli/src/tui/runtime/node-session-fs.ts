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
