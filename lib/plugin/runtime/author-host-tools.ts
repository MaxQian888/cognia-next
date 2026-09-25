/**
 * The author-callable half of the host tool surface.
 *
 * `ctx.agent.invokeTool` used to reach only the calling plugin's OWN tools, so
 * a plugin that wanted the app's search-and-read policy had to reimplement it —
 * its own provider HTTP, its own extraction, its own SSRF story. Deep Research
 * did exactly that, and the host paid for it with a `request.name ===
 * "deep_research"` branch that injected private dependencies into one
 * hard-coded plugin.
 *
 * This module replaces that with a promotion list. `web_search` and `web_fetch`
 * execute host-side through the same `runWebBuiltinTool` the agent loop uses —
 * same providers, same result cache, same source verification, same PII
 * redaction, same SSRF guard, same outbound token bucket — and a plugin gets
 * them by name, typed, with no host special-casing.
 *
 * Deliberately narrow: only {@link PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS} resolve
 * here. Everything else the host registers for its own loop (`dispatch_agent`,
 * `ask_user`, session control, working-set edits) is refused, so this never
 * becomes a general back door into host internals.
 */

import { runWebBuiltinTool, type WebToolRunDeps } from "@/lib/claude/web-builtin-tools"
import { combineAbortSignals } from "@/lib/connectivity/capacitor-http"
import {
  isAuthorCallableHostTool,
  PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS,
  type PluginHostToolFailure,
  type PluginWebCloneEnvelope,
  type PluginWebCloneInput,
  type PluginWebCloneResult,
} from "@/types/plugin/plugin-host-tools"

/**
 * Host capabilities a tool needs beyond the web deps. Each host supplies what
 * it can run: the desktop renderer wires `webCloneSnapshot` to the vendored
 * snapshot engine (`web_clone_snapshot`); the browser, mobile and CLI hosts
 * leave it out and the tool answers `unsupported-host`.
 */
export interface AuthorHostNativeRunners {
  webCloneSnapshot?: (
    job: PluginWebCloneInput["job"]
  ) => Promise<{ envelope: PluginWebCloneEnvelope }>
  /**
   * The active workspace's primary root. Every path a `web_clone` job reads or
   * writes must sit under it; with no root, the job is refused.
   */
  workspaceRoot?: () => string | undefined
}

function parseWebCloneJob(args: Record<string, unknown>): PluginWebCloneInput["job"] | null {
  const job = args.job as Record<string, unknown> | undefined
  if (!job || typeof job !== "object") return null
  const mode = job.mode
  const options = job.options
  if (mode !== "snapshot" && mode !== "convert") return null
  if (!options || typeof options !== "object" || Array.isArray(options)) return null
  if (typeof (options as Record<string, unknown>).output !== "string") return null
  if (mode === "snapshot" && (typeof job.url !== "string" || !job.url)) return null
  return {
    mode,
    ...(typeof job.url === "string" ? { url: job.url } : {}),
    options: options as Record<string, unknown>,
  }
}

function isUnderRoot(path: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = norm(path)
  const base = norm(root)
  if (!base || target.split("/").some((segment) => segment === "..")) return false
  return target === base || target.startsWith(`${base}/`)
}

/**
 * Clamp a plugin-supplied job to host policy. The plugin picks none of it: the
 * paths the engine writes (`output`) and reads (`convertLocal`) must sit under
 * the active workspace root, the private-host opt-in is the user's
 * `webTools.allowPrivateHosts` setting, and the engine's `url` is the one the
 * egress clamp checked.
 */
function clampWebCloneJob(
  job: PluginWebCloneInput["job"],
  workspaceRoot: string | undefined,
  allowPrivateHosts: boolean
): PluginWebCloneInput["job"] | string {
  if (!workspaceRoot) return "web_clone needs an open workspace to write into."
  const options = job.options
  for (const key of ["output", "convertLocal"] as const) {
    const value = options[key]
    if (value === undefined && key === "convertLocal") continue
    if (typeof value !== "string" || !isUnderRoot(value, workspaceRoot)) {
      return `web_clone ${key} must be an absolute path inside the workspace (${workspaceRoot}).`
    }
  }
  return {
    ...job,
    options: {
      ...options,
      url: job.mode === "snapshot" ? job.url : undefined,
      allowPrivateHosts: options.allowPrivateHosts === true && allowPrivateHosts,
    },
  }
}

async function runWebClone(
  args: Record<string, unknown>,
  native: AuthorHostNativeRunners | undefined,
  deps: WebToolRunDeps
): Promise<PluginWebCloneResult> {
  const job = parseWebCloneJob(args)
  if (!job) {
    return {
      ok: false,
      code: "invalid-arguments",
      error:
        'web_clone needs { job: { mode: "snapshot" | "convert", url?, options: { output, … } } } ' +
        "(a snapshot needs a url).",
    }
  }
  if (!native?.webCloneSnapshot) {
    return {
      ok: false,
      code: "unsupported-host",
      error: "web_clone runs only in the desktop app, which ships the snapshot engine.",
    }
  }
  const clamped = clampWebCloneJob(job, native.workspaceRoot?.(), deps.allowPrivateHosts === true)
  if (typeof clamped === "string") return { ok: false, code: "blocked", error: clamped }
  const { envelope } = await native.webCloneSnapshot(clamped)
  return { ok: true, envelope }
}

/** Structured refusal for a name that is not on the promotion list. */
export function notAuthorCallable(name: string): PluginHostToolFailure {
  return {
    ok: false,
    code: "not-author-callable",
    error:
      `"${name}" is not a host tool plugins may invoke. ` +
      `Author-callable host tools: ${PLUGIN_AUTHOR_CALLABLE_HOST_TOOLS.join(", ")}.`,
  }
}

/**
 * Execute one author-callable host tool against a host's resolved web deps
 * (and, for `web_clone`, the host's native runners).
 *
 * Never throws for an expected condition: an unknown name, disabled web tools,
 * a missing provider, a refused target or a spent token bucket all resolve as
 * a coded {@link PluginHostToolFailure} so the caller can branch on `code`.
 */
export async function runAuthorCallableHostTool(
  name: string,
  args: Record<string, unknown>,
  deps: WebToolRunDeps,
  options: { signal?: AbortSignal; native?: AuthorHostNativeRunners } = {}
): Promise<unknown> {
  if (!isAuthorCallableHostTool(name)) return notAuthorCallable(name)
  if (options.signal?.aborted) {
    return {
      ok: false,
      code: "execution-failed",
      error: `${name} aborted before dispatch`,
    } satisfies PluginHostToolFailure
  }
  // BOTH signals, not just the caller's. A plugin cancelling its own run must
  // cancel the fetch it started, and the host's turn-level signal must still
  // reach it — overwriting `deps.signal` meant a plugin that passes any signal
  // (Deep Research passes one on every call) silently opted the turn's Stop
  // button out of aborting its in-flight request.
  const bound: WebToolRunDeps = options.signal
    ? {
        ...deps,
        signal: deps.signal ? combineAbortSignals(deps.signal, options.signal) : options.signal,
      }
    : deps
  try {
    if (name === "web_clone") return await runWebClone(args, options.native, bound)
    return await runWebBuiltinTool(name, args, bound)
  } catch (err) {
    // `runWebBuiltinTool` returns structured failures for everything it
    // anticipates, so reaching here means an unexpected throw (a broken dep, a
    // rate-limiter that raised something other than RateLimitError). Collapse
    // it rather than letting it escape into plugin code as a raw exception.
    return {
      ok: false,
      code: "execution-failed",
      error: err instanceof Error ? err.message : String(err),
    } satisfies PluginHostToolFailure
  }
}
