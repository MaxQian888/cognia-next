// `web_clone` / `web_clone_convert` — snapshot a live web page (HTML + all
// CSS/JS/image/font assets) into a self-contained single HTML file or a
// directory bundle, with optional component extraction + framework codegen
// (Vue/React/Angular/Svelte/jQuery). Network + write tool (approval-gated).
//
// The heavy, Node-only engine (linkedom / @babel / node:http / node:fs) is
// vendored under sidecar/webclone and runs as an isolated child process; this
// module is the thin SDK-tool surface over it. See sidecar/webclone/VENDOR.md.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../../kernel/result.ts"
import type { ToolArgs } from "../../kernel/define.ts"
import { snapshotSite, CODEGEN_FRAMEWORKS, FRAMEWORK_HINTS, SNAPSHOT_MODES } from "./run.ts"
import type { EngineDeps } from "./run.ts"

/** The fields of a runner envelope this reads. */
interface EnvelopeView {
  ok?: boolean
  error?: { message?: string }
  result?: {
    output?: string
    sourceUrl?: string
    mode?: string
    stats?: { fetched?: number; total?: number; failed?: number }
    assets?: unknown
  }
}

/** Test deps when `extra` carries a `spawn`; the SDK tool context otherwise. */
const injectedDeps = (extra: unknown): Partial<EngineDeps> | undefined =>
  extra && typeof extra === "object" && typeof (extra as EngineDeps).spawn === "function"
    ? (extra as Partial<EngineDeps>)
    : undefined

/** Shape a runner envelope into a compact tool result. */
function envelopeToResult(value: unknown, label: string) {
  if (!value || typeof value !== "object") {
    return toolError(`web-clone returned no result`, label)
  }
  const envelope = value as EnvelopeView
  if (envelope.ok === false) {
    const e = envelope.error || {}
    return toolError(e.message || "web-clone failed", label)
  }
  const r = envelope.result || {}
  const fetched = r.stats?.fetched ?? 0
  const total = r.stats?.total ?? 0
  const failed = r.stats?.failed ?? 0
  return toolText({
    message: `Snapshot written to ${r.output} (${fetched}/${total} assets fetched${failed ? `, ${failed} failed` : ""}).`,
    sourceUrl: r.sourceUrl,
    mode: r.mode,
    output: r.output,
    stats: r.stats,
    // Cap the per-asset detail so a 5000-asset page can't blow the result cap.
    assets: Array.isArray(r.assets) ? r.assets.slice(0, 200) : [],
  })
}

// ---- web_clone (snapshot a URL) -------------------------------------------

export const webCloneShape = {
  cwd: z
    .string()
    .min(1)
    .describe("Absolute path inside the target workspace. Output is confined under it."),
  url: z
    .string()
    .min(1)
    .describe(
      "HTTP(S) URL of the page to snapshot. Private/loopback hosts are blocked unless allowPrivateHosts."
    ),
  output: z
    .string()
    .min(1)
    .describe(
      "Output path (relative to cwd or absolute inside it). For mode 'single' a .html file; for 'bundle' a directory."
    ),
  mode: z
    .enum(SNAPSHOT_MODES)
    .optional()
    .describe(
      "'single' = one self-contained HTML (assets inlined as data URIs); 'bundle' = directory with separated assets. Default 'bundle'."
    ),
  extractComponents: z
    .boolean()
    .optional()
    .describe(
      "Also analyze the page into a component structure (template/style/logic + confidence). Default false."
    ),
  framework: z
    .enum(CODEGEN_FRAMEWORKS)
    .optional()
    .describe(
      "Generate framework component code from the extracted components. Implies extractComponents."
    ),
  frameworkHint: z
    .enum(FRAMEWORK_HINTS)
    .optional()
    .describe(
      "Hint the extractor about the page's original framework to improve component boundaries."
    ),
  maxAssets: z.number().int().optional().describe("Max assets to download (1-5000, default 100)."),
  concurrency: z.number().int().optional().describe("Concurrent downloads (1-32, default 6)."),
  timeout: z
    .number()
    .int()
    .optional()
    .describe("Per-resource timeout in ms (1000-120000, default 15000)."),
  maxFileSize: z
    .number()
    .int()
    .optional()
    .describe("Hard per-file byte cap (0 disables, default engine limit)."),
  pretty: z.boolean().optional().describe("Prettify the output HTML. Default false."),
  allowPrivateHosts: z
    .boolean()
    .optional()
    .describe(
      "Permit private/loopback/link-local targets (SSRF opt-in). Default false — leave off unless you trust the target."
    ),
  codegenGenerateDrafts: z
    .boolean()
    .optional()
    .describe("Also emit complete project scaffolds under __drafts__/. Default false."),
  codegenExtractShared: z
    .boolean()
    .optional()
    .describe("Extract shared logic (api/utils) into shared/. Default false."),
}

export async function execWebClone(args: ToolArgs<typeof webCloneShape>, deps?: unknown) {
  try {
    const envelope = await snapshotSite(
      {
        cwd: args.cwd,
        url: args.url,
        output: args.output,
        mode: args.mode,
        extractComponents: args.extractComponents,
        framework: args.framework,
        frameworkHint: args.frameworkHint,
        maxAssets: args.maxAssets,
        concurrency: args.concurrency,
        timeout: args.timeout,
        maxFileSize: args.maxFileSize,
        pretty: args.pretty,
        allowPrivateHosts: args.allowPrivateHosts,
        codegenGenerateDrafts: args.codegenGenerateDrafts,
        codegenExtractShared: args.codegenExtractShared,
      },
      injectedDeps(deps)
    )
    return envelopeToResult(envelope, "web_clone")
  } catch (err) {
    return toolError(err, "web_clone")
  }
}

export const webCloneTool = tool(
  "web_clone",
  "Snapshot a live web page — download its HTML plus all CSS/JS/image/font assets and bundle them " +
    "into a self-contained single HTML file (mode 'single') or a directory (mode 'bundle'). Optionally " +
    "extract a component structure and generate Vue/React/Angular/Svelte/jQuery code. Writes into the " +
    "workspace (approval-gated). Private/loopback targets are blocked unless allowPrivateHosts is set.",
  webCloneShape,
  execWebClone
)

// ---- web_clone_convert (codegen from a local snapshot) --------------------

export const webCloneConvertShape = {
  cwd: z
    .string()
    .min(1)
    .describe(
      "Absolute path inside the target workspace. Both input and output are confined under it."
    ),
  input: z
    .string()
    .min(1)
    .describe(
      "Existing local snapshot to convert: a bundle directory (with index.html) or a single .html file."
    ),
  output: z
    .string()
    .min(1)
    .describe(
      "Output directory (relative to cwd or absolute inside it) for the generated components."
    ),
  framework: z
    .enum(CODEGEN_FRAMEWORKS)
    .optional()
    .describe(
      "Framework to generate. Omit to only extract the component structure without codegen."
    ),
  frameworkHint: z
    .enum(FRAMEWORK_HINTS)
    .optional()
    .describe("Hint the extractor about the page's original framework."),
  codegenGenerateDrafts: z
    .boolean()
    .optional()
    .describe("Also emit complete project scaffolds under __drafts__/. Default false."),
  codegenExtractShared: z
    .boolean()
    .optional()
    .describe("Extract shared logic (api/utils) into shared/. Default false."),
}

export async function execWebCloneConvert(
  args: ToolArgs<typeof webCloneConvertShape>,
  deps?: unknown
) {
  try {
    const envelope = await snapshotSite(
      {
        cwd: args.cwd,
        convertLocal: args.input,
        output: args.output,
        framework: args.framework,
        frameworkHint: args.frameworkHint,
        codegenGenerateDrafts: args.codegenGenerateDrafts,
        codegenExtractShared: args.codegenExtractShared,
      },
      injectedDeps(deps)
    )
    return envelopeToResult(envelope, "web_clone_convert")
  } catch (err) {
    return toolError(err, "web_clone_convert")
  }
}

export const webCloneConvertTool = tool(
  "web_clone_convert",
  "Run component extraction + framework codegen on an EXISTING local snapshot (a bundle directory or " +
    "single HTML file) without re-fetching the URL. Generates Vue/React/Angular/Svelte/jQuery components. " +
    "Writes into the workspace (approval-gated).",
  webCloneConvertShape,
  execWebCloneConvert
)

// ---- category export ------------------------------------------------------

/** Fixed registration order — do not reorder (prompt-cache stability). New tools APPEND. */
export const WEBCLONE_TOOL_NAMES = Object.freeze(["web_clone", "web_clone_convert"])

/** All webclone tool definitions, in WEBCLONE_TOOL_NAMES order. */
export const webcloneTools = [webCloneTool, webCloneConvertTool]

for (let i = 0; i < webcloneTools.length; i++) {
  if (webcloneTools[i]!.name !== WEBCLONE_TOOL_NAMES[i]) {
    throw new Error(
      `webclone tool order drift: expected ${WEBCLONE_TOOL_NAMES[i]}, got ${webcloneTools[i]!.name}`
    )
  }
}

/** Test-only handler exports. */
export const __testExports = { execWebClone, execWebCloneConvert, envelopeToResult }
