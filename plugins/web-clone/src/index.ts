/**
 * Web Clone — built-in plugin.
 *
 * Adds a user-triggered `/web-clone` slash command that snapshots a live web
 * page (HTML + all CSS/JS/image/font assets) into a self-contained file or a
 * directory bundle, with optional component extraction + framework codegen —
 * or re-runs that extraction/codegen on an already-saved snapshot
 * (`--convert`), without fetching.
 *
 * This is the on-demand, user-facing entry point to the same vendored engine
 * that backs (a) the sidecar `web_clone` / `web_clone_convert` agent tools and
 * (b) the `io.webClone` workflow node. All three funnel through the
 * deterministic `web_clone_snapshot` Tauri command
 * (`src-tauri/src/webclone.rs`), so the engine — and its SSRF gate — is
 * exercised identically everywhere. Desktop only: the engine is a Node
 * process reached via Tauri.
 *
 * Relative paths resolve under the active project root
 * (`ctx.workspace.getActiveRoot()`). User-facing strings live in plugin.json
 * (`i18n.locales`) and translate through `ctx.i18n.t`.
 */

import type { PluginCommandContext, PluginContext, PluginWebCloneInput } from "@cognia/plugin-sdk"
import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { englishWebCloneT, type WebCloneTranslate } from "./i18n"

export type { WebCloneTranslate } from "./i18n"

const CODEGEN_FRAMEWORKS = ["vue", "react", "angular", "svelte", "jquery"] as const
type CodegenFramework = (typeof CODEGEN_FRAMEWORKS)[number]

const FRAMEWORK_HINTS = ["vue", "react", "svelte"] as const
type FrameworkHint = (typeof FRAMEWORK_HINTS)[number]

/** Machine-checkable parse failures — translated at the command boundary. */
export type WebCloneParseError =
  | { code: "missingValue"; flag: string }
  | { code: "unknownFlag"; flag: string }
  | { code: "unexpectedArg"; value: string }
  | { code: "invalidValue"; flag: string; value: string }
  | { code: "convertWithUrl" }

interface ParsedCommand {
  url?: string
  output?: string
  /** `--convert <path>` — run extraction/codegen on a saved snapshot. */
  convertLocal?: string
  mode: "single" | "bundle"
  framework?: CodegenFramework
  frameworkHint?: FrameworkHint
  extractComponents: boolean
  codegenTypescript: boolean
  codegenGenerateDrafts: boolean
  codegenExtractShared: boolean
  maxAssets?: number
  concurrency?: number
  timeout?: number
  maxFileSize?: number
  pretty: boolean
  allowPrivateHosts: boolean
  help: boolean
  errors: WebCloneParseError[]
}

interface WebCloneEnvelope {
  ok: boolean
  result?: {
    output: string
    stats: Record<string, number>
    mode: string
  }
  error?: { name: string; message: string; reason?: string }
}

const NUMBER_FLAGS = {
  "--max-assets": "maxAssets",
  "--concurrency": "concurrency",
  "--timeout": "timeout",
  "--max-file-size": "maxFileSize",
} as const

/**
 * Parse the raw slash-command argument string into a structured request.
 *
 * Strict rather than silent: unknown flags, dangling values (`-o` followed by
 * another flag used to BE swallowed as the path), extra positionals, and
 * invalid enum/number values all land in `errors` so the caller can report
 * them instead of running a snapshot the user did not ask for. Long AND short
 * flags accept the `--flag=value` form — the only way to pass a value that
 * starts with `-`.
 */
export function parseWebCloneArgs(raw: string): ParsedCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const parsed: ParsedCommand = {
    mode: "bundle",
    allowPrivateHosts: false,
    extractComponents: false,
    codegenTypescript: true,
    codegenGenerateDrafts: false,
    codegenExtractShared: false,
    pretty: false,
    help: false,
    errors: [],
  }

  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i]!
    let inlineValue: string | undefined
    if (tok.startsWith("-")) {
      const eq = tok.indexOf("=")
      if (eq !== -1) {
        inlineValue = tok.slice(eq + 1)
        tok = tok.slice(0, eq)
      }
    }

    /** A value-taking flag: `--flag=v`, or the next token when it isn't another flag. */
    const readValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue
      const next = tokens[i + 1]
      if (next === undefined || next.startsWith("-")) {
        parsed.errors.push({ code: "missingValue", flag: tok })
        return undefined
      }
      i++
      return next
    }

    /** A boolean flag: `--flag=x` is an error — the flag takes no value. */
    const boolFlag = (apply: () => void): void => {
      if (inlineValue !== undefined) {
        parsed.errors.push({ code: "invalidValue", flag: tok, value: inlineValue })
        return
      }
      apply()
    }

    switch (tok) {
      case "-h":
      case "--help":
        boolFlag(() => {
          parsed.help = true
        })
        continue
      case "--single":
        boolFlag(() => {
          parsed.mode = "single"
        })
        continue
      case "--private":
        boolFlag(() => {
          parsed.allowPrivateHosts = true
        })
        continue
      case "--pretty":
        boolFlag(() => {
          parsed.pretty = true
        })
        continue
      case "--extract-components":
        boolFlag(() => {
          parsed.extractComponents = true
        })
        continue
      case "--drafts":
        boolFlag(() => {
          parsed.codegenGenerateDrafts = true
        })
        continue
      case "--extract-shared":
        boolFlag(() => {
          parsed.codegenExtractShared = true
        })
        continue
      case "--no-typescript":
        boolFlag(() => {
          parsed.codegenTypescript = false
        })
        continue
      case "-o":
      case "--output": {
        const v = readValue()
        if (v !== undefined) parsed.output = v
        continue
      }
      case "-m":
      case "--mode": {
        const v = readValue()
        if (v !== undefined) {
          if (v === "single" || v === "bundle") parsed.mode = v
          else parsed.errors.push({ code: "invalidValue", flag: tok, value: v })
        }
        continue
      }
      case "--framework": {
        const v = readValue()
        if (v !== undefined) {
          if ((CODEGEN_FRAMEWORKS as readonly string[]).includes(v)) {
            parsed.framework = v as CodegenFramework
          } else {
            parsed.errors.push({ code: "invalidValue", flag: tok, value: v })
          }
        }
        continue
      }
      case "--framework-hint": {
        const v = readValue()
        if (v !== undefined) {
          if ((FRAMEWORK_HINTS as readonly string[]).includes(v)) {
            parsed.frameworkHint = v as FrameworkHint
          } else {
            parsed.errors.push({ code: "invalidValue", flag: tok, value: v })
          }
        }
        continue
      }
      case "--convert": {
        const v = readValue()
        if (v !== undefined) parsed.convertLocal = v
        continue
      }
      default:
        break
    }

    // `hasOwn`, not `in`: a prototype name like `--has-own-property` must not
    // reach the table through the prototype chain.
    if (Object.hasOwn(NUMBER_FLAGS, tok)) {
      const v = readValue()
      if (v !== undefined) {
        const n = Number(v)
        if (!Number.isFinite(n)) {
          parsed.errors.push({ code: "invalidValue", flag: tok, value: v })
        } else {
          parsed[NUMBER_FLAGS[tok as keyof typeof NUMBER_FLAGS]] = n
        }
      }
      continue
    }

    if (tok.startsWith("-") && tok !== "-") {
      parsed.errors.push({ code: "unknownFlag", flag: tok })
      continue
    }

    if (parsed.url === undefined) {
      parsed.url = tok
    } else {
      parsed.errors.push({ code: "unexpectedArg", value: tok })
    }
  }

  if (parsed.convertLocal && parsed.url) {
    parsed.errors.push({ code: "convertWithUrl" })
  }
  return parsed
}

/** True for an absolute POSIX or Windows path. */
function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
}

/** `~` is shell syntax — expanding it silently as a literal dir is worse than refusing. */
function startsWithTilde(p: string): boolean {
  return p.startsWith("~")
}

/**
 * Join a workspace-relative path under `rootDir`, rejecting `..` segments.
 * Stripping only the leading separators left `..` free to walk back out, so
 * `-o ../../../.ssh/authorized_keys` silently wrote outside the workspace
 * while still reading as a workspace-relative path. (An ABSOLUTE path is a
 * separate, deliberate escape hatch handled by the callers.)
 */
function joinUnderWorkspace(rootDir: string, rel: string, t: WebCloneTranslate): string {
  const sep = rootDir.includes("\\") ? "\\" : "/"
  const base = rootDir.replace(/[\\/]+$/, "")
  const segments = rel
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
  if (segments.some((segment) => segment === "..")) {
    throw new Error(t("outsideWorkspace", { path: rel }))
  }
  // Normalize away "." segments so "./snap" lands at <root>/snap, not
  // <root>/./snap — the engine would work either way, but the resolved path
  // is what the user sees in the result line.
  const clean = segments.filter((segment) => segment !== ".").join(sep)
  return clean ? base + sep + clean : base
}

/**
 * Resolve the output path to an absolute path. Explicit absolute paths pass
 * through; otherwise the output resolves under the open Source-Control
 * workspace — `snapshots/<host>-<stamp>` for snapshots,
 * `snapshots/convert-<stamp>` for `--convert`. `stamp` is injected for
 * deterministic tests.
 */
export function resolveOutput(
  parsed: ParsedCommand,
  rootDir: string | null,
  stamp: string,
  t: WebCloneTranslate = englishWebCloneT
): string {
  const explicit = parsed.output
  if (explicit) {
    if (startsWithTilde(explicit)) throw new Error(t("tildeUnsupported", { path: explicit }))
    if (isAbsolutePath(explicit)) return explicit
    if (!rootDir) throw new Error(t("noWorkspace"))
    return joinUnderWorkspace(rootDir, explicit, t)
  }
  if (!rootDir) {
    throw new Error(t("noWorkspace"))
  }
  const sep = rootDir.includes("\\") ? "\\" : "/"
  const base = rootDir.replace(/[\\/]+$/, "")
  const dir = parsed.convertLocal
    ? `snapshots${sep}convert-${stamp}`
    : `snapshots${sep}${safeHostSlug(parsed.url ?? "")}-${stamp}`
  const suffix = !parsed.convertLocal && parsed.mode === "single" ? ".html" : ""
  return base + sep + dir + suffix
}

/**
 * Resolve the `--convert` input path under the workspace — same confinement
 * as the output path (absolute passes through, relative joins, `..` rejected).
 */
export function resolveInputPath(
  path: string,
  rootDir: string | null,
  t: WebCloneTranslate = englishWebCloneT
): string {
  if (startsWithTilde(path)) throw new Error(t("tildeUnsupported", { path }))
  if (isAbsolutePath(path)) return path
  if (!rootDir) throw new Error(t("noWorkspace"))
  return joinUnderWorkspace(rootDir, path, t)
}

/** A filesystem-safe token derived from the URL host, for the default output dir. */
function safeHostSlug(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_") || "snapshot"
  } catch {
    return "snapshot"
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Build the runner job from a parsed command + resolved absolute paths. */
export function buildJob(
  parsed: ParsedCommand,
  output: string,
  convertLocal?: string
): Record<string, unknown> {
  const wantsCodegen = Boolean(parsed.framework)
  const isConvert = Boolean(parsed.convertLocal)
  const options: Record<string, unknown> = {
    url: isConvert ? undefined : parsed.url,
    output,
    mode: parsed.mode,
    maxAssets: clampInt(parsed.maxAssets, 100, 1, 5000),
    concurrency: clampInt(parsed.concurrency, 6, 1, 32),
    timeout: clampInt(parsed.timeout, 15000, 1000, 120000),
    retryCount: 1,
    retryInitialDelay: 200,
    retryMaxDelay: 2000,
    inline: true,
    pretty: parsed.pretty,
    // Convert IS the extraction pipeline — there is nothing else to run.
    extractComponents: parsed.extractComponents || wantsCodegen || isConvert,
    allowPrivateHosts: parsed.allowPrivateHosts,
  }
  if (isConvert) options.convertLocal = convertLocal
  if (parsed.frameworkHint) options.frameworkHint = parsed.frameworkHint
  if (parsed.maxFileSize !== undefined) {
    options.maxFileSize = clampInt(parsed.maxFileSize, 0, 0, 1024 * 1024 * 1024)
  }
  if (wantsCodegen) {
    options.frameworkCodegen = {
      framework: parsed.framework,
      typescript: parsed.codegenTypescript,
      cssModules: false,
      generateDrafts: parsed.codegenGenerateDrafts,
      extractSharedLogic: parsed.codegenExtractShared,
    }
  }
  return isConvert ? { mode: "convert", options } : { mode: "snapshot", url: parsed.url, options }
}

function translateParseError(e: WebCloneParseError, t: WebCloneTranslate): string {
  switch (e.code) {
    case "missingValue":
      return t("missingValue", { flag: e.flag })
    case "unknownFlag":
      return t("unknownFlag", { flag: e.flag })
    case "unexpectedArg":
      return t("unexpectedArg", { value: e.value })
    case "invalidValue":
      return t("invalidValue", { flag: e.flag, value: e.value })
    case "convertWithUrl":
      return t("convertWithUrl")
  }
}

/** Thrown by {@link raceAbort} when the caller's signal fires first. */
class WebCloneCancelled extends Error {
  constructor() {
    super("web-clone cancelled")
    this.name = "WebCloneCancelled"
  }
}

/**
 * Settle with `work`, or reject with {@link WebCloneCancelled} as soon as
 * `signal` aborts. The Tauri command itself cannot be cancelled from the
 * renderer (the runner is killed only by its own timeout), so this stops the
 * command from WAITING — the user gets their answer at once — and the message
 * says a started snapshot may still finish.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new WebCloneCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WebCloneCancelled())
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

export interface WebCloneCommandDeps {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<{ envelope: WebCloneEnvelope }>
  rootDir: () => string | null
  now: () => number
  t?: WebCloneTranslate
  /** The invoking host's cancellation signal (`PluginCommandContext.signal`). */
  signal?: AbortSignal
  /** The invoking host's progress sink (`PluginCommandContext.reportProgress`). */
  reportProgress?: (progress: number, message?: string) => void
}

/**
 * Run a parsed `/web-clone` command. Exported for tests (deps injectable).
 * Returns `{ ok, message }` — `ok` drives the toast severity; `message` is
 * returned through the structured command contract so it lands in the chat
 * transcript, not just a transient toast.
 */
export async function runWebCloneCommand(
  raw: string,
  deps: WebCloneCommandDeps
): Promise<{ ok: boolean; message: string }> {
  const t = deps.t ?? englishWebCloneT
  const parsed = parseWebCloneArgs(raw)
  if (parsed.help) {
    return { ok: true, message: t("usage") }
  }
  if (parsed.errors.length > 0) {
    const details = parsed.errors.map((e) => translateParseError(e, t)).join("; ")
    return { ok: false, message: `web-clone: ${details}\n${t("usage")}` }
  }
  if (!parsed.url && !parsed.convertLocal) {
    return { ok: true, message: `${t("intro")}\n${t("usage")}` }
  }
  let output: string
  let convertLocal: string | undefined
  try {
    const rootDir = deps.rootDir()
    output = resolveOutput(parsed, rootDir, String(deps.now()), t)
    if (parsed.convertLocal) {
      convertLocal = resolveInputPath(parsed.convertLocal, rootDir, t)
    }
  } catch (err) {
    return { ok: false, message: `web-clone: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (deps.signal?.aborted) return { ok: false, message: t("cancelled") }
  const job = buildJob(parsed, output, convertLocal)
  deps.reportProgress?.(
    0,
    parsed.convertLocal ? t("progressConvert") : t("progressSnapshot", { url: parsed.url ?? "" })
  )
  try {
    const { envelope } = await raceAbort(deps.invoke("web_clone_snapshot", { job }), deps.signal)
    if (!envelope.ok || !envelope.result) {
      const error = envelope.error?.message ?? "unknown error"
      return {
        ok: false,
        message:
          envelope.error?.reason === "private-host"
            ? t("failedPrivateHost", { error })
            : t("failed", { error }),
      }
    }
    deps.reportProgress?.(1)
    const r = envelope.result
    if (parsed.convertLocal || r.mode === "convert") {
      return { ok: true, message: t("resultConvert", { output: r.output }) }
    }
    const fetched = r.stats.fetched ?? 0
    const total = r.stats.total ?? 0
    const failed = r.stats.failed ?? 0
    const skipped = r.stats.skipped ?? 0
    return {
      ok: true,
      message:
        failed > 0 || skipped > 0
          ? t("resultSnapshotIssues", { output: r.output, fetched, total, failed, skipped })
          : t("resultSnapshot", { output: r.output, fetched, total }),
    }
  } catch (err) {
    if (err instanceof WebCloneCancelled) return { ok: false, message: t("cancelled") }
    return {
      ok: false,
      message: t("failed", { error: err instanceof Error ? err.message : String(err) }),
    }
  }
}

// plugin.json is the manifest source of truth — `commands[]` and the
// `i18n.locales` bundle the manager registers before `activate()` runs.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: (ctx: PluginContext) => {
    const t: WebCloneTranslate = (key, params) => ctx.i18n.t(key, params)

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here. `hooks.onCommand` receives whitespace-split argv, so the raw tail
    // is rejoined for handlers that parse their own argument string. The
    // structured `{ handled, message }` return makes the result line the
    // command's chat response — not a generic placeholder.
    ctx.logger.info("web-clone plugin activated")
    return {
      onCommand: async (command: string, args: string[], context?: PluginCommandContext) => {
        if (command !== "web-clone") return false
        if (!ctx.capabilities.tauri) {
          const message = t("desktopOnly")
          ctx.ui.showToast(message, "error")
          return { handled: true, message }
        }
        const result = await runWebCloneCommand(context?.rawArgs ?? args.join(" "), {
          // The snapshot engine is a host tool: the host runs it (desktop
          // only), checks this plugin's network allowlist against the target,
          // and requires the network + filesystem permissions it declares.
          invoke: async (_cmd, { job }) => {
            const outcome = await ctx.agent.invokeTool(
              "web_clone",
              { job: job as PluginWebCloneInput["job"] },
              {
                ...(context?.signal ? { signal: context.signal } : {}),
                ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
              }
            )
            if (!outcome.ok) throw new Error(outcome.error)
            return { envelope: outcome.envelope as WebCloneEnvelope }
          },
          rootDir: () => ctx.workspace.getActiveRoot() ?? null,
          now: () => Date.now(),
          t,
          signal: context?.signal,
          reportProgress: context?.reportProgress,
        })
        ctx.ui.showToast(result.message, result.ok ? "success" : "error")
        return { handled: true, message: result.message }
      },
    }
  },
})
