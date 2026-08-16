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

/** Read `navigator.platform` defensively (absent in node / SSR). */
function readPlatform(): string {
  return typeof navigator !== "undefined" && navigator.platform ? navigator.platform : ""
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
