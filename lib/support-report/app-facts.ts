/**
 * Flat, serialisable build facts that open every diagnostics blob.
 *
 * Shared by the tray "Copy diagnostics" action and the `app` section of a
 * support report so the two never disagree about what "the version line" says.
 */

import {
  APP_NAME,
  APP_VERSION,
  getBuildInfo,
  getReleaseChannel,
  getRuntimeVersions,
} from "@/lib/app-metadata"
import { detectOsFamily } from "@/lib/platform/os"

export interface DiagnosticsFacts {
  name: string
  version: string
  channel: string
  commit: string
  buildTime: string
  tauri: string | null
  react: string
  engine: string | null
  platform: string
}

/**
 * Render the facts as a clipboard-friendly block. Pure. Empty/unknown fields
 * are shown as "—" so a pasted report is never silently missing a line.
 */
export function formatDiagnostics(f: DiagnosticsFacts): string {
  const dash = (v: string | null | undefined) => (v && v.length ? v : "—")
  return [
    `${f.name} ${f.version} (${f.channel})`,
    `Commit:   ${dash(f.commit)}`,
    `Built:    ${dash(f.buildTime)}`,
    `Platform: ${dash(f.platform)}`,
    `Tauri:    ${dash(f.tauri)}`,
    `React:    ${dash(f.react)}`,
    `Engine:   ${dash(f.engine)}`,
  ].join("\n")
}

/**
 * The OS family, not `navigator.platform` — that string says `MacIntel` on
 * every Mac ever built and on an iPad, which is exactly the line a support
 * report must not get wrong. Empty when nothing can name it, so
 * {@link formatDiagnostics} renders the dash.
 */
function readPlatform(): string {
  const family = detectOsFamily()
  return family === "unknown" ? "" : family
}

/** Gather the live facts from the app-metadata helpers. */
export async function gatherDiagnostics(): Promise<DiagnosticsFacts> {
  const build = getBuildInfo()
  const runtime = await getRuntimeVersions()
  return {
    name: APP_NAME,
    version: APP_VERSION,
    channel: getReleaseChannel(),
    commit: build.commit,
    buildTime: build.buildTime,
    tauri: runtime.tauri,
    react: runtime.react,
    engine: runtime.engine,
    platform: readPlatform(),
  }
}
