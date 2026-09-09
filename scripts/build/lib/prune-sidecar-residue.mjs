import fs from "node:fs"
import path from "node:path"

/**
 * What the JavaScript CLI layout itself puts under `cli/dist/sidecar/`. The
 * sidecar HOST is not among them: `resolveSidecarScript` walks up from the
 * bundle and is meant to reach the repo's own `sidecar/claude-host.mjs`.
 */
export const JS_LAYOUT_SIDECAR_ENTRIES = new Set(["pi-extension", "ast-grep", "ast-grep.exe"])

/**
 * Remove whatever an earlier packaging layout left under `<outDir>/sidecar`.
 *
 * The binary build used to bundle the sidecar host into `cli/dist/sidecar/`
 * before it moved to `cli/dist/bin/`. Nothing rewrites that old copy any more,
 * and because the runtime walk-up from `cli/dist/chunks/` reaches
 * `cli/dist/sidecar/claude-host.mjs` one hop before the repo's `sidecar/`,
 * every dev run of the JavaScript bundle silently used a sidecar frozen at the
 * date of that build. A bundled host that is days old looks exactly like a
 * current one from the outside, which is why this prunes rather than warns.
 *
 * @param {{ outDir: string, log?: (line: string) => void }} options
 * @returns {string[]} the entries that were removed, relative to the sidecar dir
 */
export function pruneSidecarResidue({ outDir, log = () => {} }) {
  const sidecarDir = path.join(outDir, "sidecar")
  if (!fs.existsSync(sidecarDir)) return []
  const removed = []
  for (const entry of fs.readdirSync(sidecarDir)) {
    if (JS_LAYOUT_SIDECAR_ENTRIES.has(entry)) continue
    fs.rmSync(path.join(sidecarDir, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  if (removed.length > 0) {
    log(
      `build-cli: removed ${removed.length} stale sidecar entr${removed.length === 1 ? "y" : "ies"} from ${sidecarDir}: ${removed.join(", ")}`
    )
  }
  return removed
}
