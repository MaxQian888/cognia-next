/**
 * Web-clone workflow node executor (`io.webClone`).
 *
 * Snapshots a live web page — HTML + all CSS/JS/image/font assets — into a
 * self-contained single HTML file or a directory bundle, with optional
 * component extraction + Vue/React/Angular/Svelte/jQuery codegen. The heavy
 * engine is vendored under `sidecar/webclone` and runs as an isolated child
 * process; this executor delegates DETERMINISTICALLY (no agent turn) through the
 * `web_clone_snapshot` Tauri command (`src-tauri/src/webclone.rs`), mirroring
 * how the terminal-session nodes reach native work via `invoke(...)`.
 *
 * Desktop only — the runner needs Node + the vendored engine, which don't exist
 * in the browser/mobile shells. The output path resolves under the active
 * Source-Control workspace (like the git nodes) unless an absolute path is given.
 */

import { isTauri } from "@/lib/tauri"
import { useGitStore } from "@/stores/git/git-store"
import { registerNodeExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

const CODEGEN_FRAMEWORKS = ["vue", "react", "angular", "svelte", "jquery"] as const
type CodegenFramework = (typeof CODEGEN_FRAMEWORKS)[number]

/** Runner envelope returned by the `web_clone_snapshot` command. */
interface WebCloneEnvelope {
  ok: boolean
  result?: {
    sourceUrl: string
    timestamp: string
    mode: "snapshot" | "convert"
    output: string
    stats: Record<string, number>
    assets: Array<{
      originUrl: string
      type: string
      status: string
      size: number
      localPath?: string
      error?: string
    }>
  }
  error?: { name: string; message: string; reason?: string }
}

function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** True for an absolute POSIX or Windows path (drive-letter, UNC, or root). */
function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
}

/** Resolve the output path to an absolute path, joining under the workspace root. */
export function resolveWebCloneOutput(output: string): { output: string; cwd?: string } {
  const root = useGitStore.getState().rootDir
  if (isAbsolutePath(output)) {
    return { output, cwd: root ?? undefined }
  }
  if (!root) {
    throw new Error(
      "io.webClone: a relative output path needs an open workspace (Source Control) — or provide an absolute path"
    )
  }
  const sep = root.includes("\\") ? "\\" : "/"
  const abs = root.replace(/[\\/]+$/, "") + sep + output.replace(/^[\\/]+/, "")
  return { output: abs, cwd: root }
}

/** Build the engine options object from node params. Exported for tests. */
export function buildWebCloneOptions(params: Record<string, unknown>): {
  mode: "snapshot"
  url: string
  options: Record<string, unknown>
} {
  const url = strParam(params, "url")
  if (!url) throw new Error("io.webClone requires a non-empty URL")
  const outputParam = strParam(params, "output")
  if (!outputParam) throw new Error("io.webClone requires an output path")

  const mode = strParam(params, "mode") === "single" ? "single" : "bundle"
  const framework = strParam(params, "framework") as CodegenFramework | undefined
  if (framework && !CODEGEN_FRAMEWORKS.includes(framework)) {
    throw new Error(`io.webClone: unknown framework "${framework}"`)
  }
  const frameworkHint = strParam(params, "frameworkHint")
  const wantsCodegen = Boolean(framework)
  const { output } = resolveWebCloneOutput(outputParam)

  const options: Record<string, unknown> = {
    url,
    output,
    mode,
    maxAssets: clampInt(numParam(params, "maxAssets"), 100, 1, 5000),
    concurrency: clampInt(numParam(params, "concurrency"), 6, 1, 32),
    timeout: clampInt(numParam(params, "timeout"), 15000, 1000, 120000),
    retryCount: 1,
    retryInitialDelay: 200,
    retryMaxDelay: 2000,
    inline: true,
    pretty: boolParam(params, "pretty"),
    extractComponents: boolParam(params, "extractComponents") || wantsCodegen,
    allowPrivateHosts: boolParam(params, "allowPrivateHosts"),
  }
  if (frameworkHint) options.frameworkHint = frameworkHint
  const maxFileSize = numParam(params, "maxFileSize")
  if (maxFileSize !== undefined)
    options.maxFileSize = clampInt(maxFileSize, 0, 0, 1024 * 1024 * 1024)
  if (wantsCodegen) {
    options.frameworkCodegen = {
      framework,
      typescript: true,
      cssModules: false,
      generateDrafts: boolParam(params, "codegenGenerateDrafts"),
      extractSharedLogic: boolParam(params, "codegenExtractShared"),
    }
  }
  return { mode: "snapshot", url, options }
}

registerNodeExecutor({
  kind: "io.webClone",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    if (!isTauri()) {
      throw new Error(
        "io.webClone runs only on the desktop app (needs the vendored snapshot engine)"
      )
    }
    const job = buildWebCloneOptions(ctx.params)
    ctx.log("info", `Snapshotting ${job.url} → ${String(job.options.output)}`)

    const { invoke } = await import("@tauri-apps/api/core")
    const outcome = await invoke<{ envelope: WebCloneEnvelope }>("web_clone_snapshot", {
      job: { mode: job.mode, url: job.url, options: job.options },
    })
    const envelope = outcome.envelope
    if (!envelope.ok || !envelope.result) {
      const err = envelope.error
      throw new Error(err ? `${err.name}: ${err.message}` : "web-clone snapshot failed")
    }
    const r = envelope.result
    ctx.log(
      "info",
      `Snapshot complete: ${r.stats.fetched ?? 0}/${r.stats.total ?? 0} assets → ${r.output}`
    )
    return {
      output: {
        sourceUrl: r.sourceUrl,
        mode: r.mode,
        output: r.output,
        stats: r.stats,
        assets: r.assets,
      },
    }
  },
})
