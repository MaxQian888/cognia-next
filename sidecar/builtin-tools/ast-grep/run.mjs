// Execute the `ast-grep` CLI with an argv array (never a shell string — the
// pattern must not be able to break out) and parse its `--json=compact`
// output. Ported from oh-my-opencode-slim's `src/tools/ast-grep/cli.ts`, adapted
// to cognia's `core/rg.mjs` spawn conventions (node:child_process, byte cap,
// timeout, no-binary → structured error).

import { spawnInProcessSandbox as spawn } from "../shared/exec.mjs"
import { detectAstGrep } from "./binary.mjs"

export const DEFAULT_MAX_MATCHES = 100
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10 MB
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * @typedef {object} SgMatch
 * @property {string} file
 * @property {string} text
 * @property {{ start: { line: number, column: number }, end: { line: number, column: number } }} range
 * @property {string} [replacement]
 */

/**
 * @typedef {object} SgResult
 * @property {SgMatch[]} matches
 * @property {number} totalMatches
 * @property {boolean} [truncated]
 * @property {string} [truncatedReason]
 * @property {string} [error]
 */

/**
 * Build the argv for an `ast-grep run` invocation.
 * @param {{
 *   pattern: string,
 *   lang: string,
 *   paths?: string[],
 *   globs?: string[],
 *   rewrite?: string,
 *   context?: number,
 *   updateAll?: boolean,
 * }} options
 * @returns {string[]}
 */
export function buildArgs(options) {
  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"]

  if (options.rewrite) {
    args.push("-r", options.rewrite)
    if (options.updateAll) args.push("--update-all")
  }
  if (typeof options.context === "number" && options.context > 0) {
    args.push("-C", String(options.context))
  }
  if (Array.isArray(options.globs)) {
    for (const glob of options.globs) args.push("--globs", glob)
  }
  const paths = Array.isArray(options.paths) && options.paths.length > 0 ? options.paths : ["."]
  args.push(...paths)
  return args
}

/**
 * Normalise one raw `--json=compact` entry into an `SgMatch`. ast-grep emits
 * 0-based line/column numbers under `range.start` / `range.end`.
 * @param {any} raw
 * @returns {SgMatch | null}
 */
function toMatch(raw) {
  if (!raw || typeof raw !== "object") return null
  const range = raw.range && typeof raw.range === "object" ? raw.range : {}
  const start = range.start && typeof range.start === "object" ? range.start : {}
  const end = range.end && typeof range.end === "object" ? range.end : {}
  /** @type {SgMatch} */
  const match = {
    file: typeof raw.file === "string" ? raw.file : "",
    text: typeof raw.text === "string" ? raw.text : "",
    range: {
      start: { line: Number(start.line) || 0, column: Number(start.column) || 0 },
      end: { line: Number(end.line) || 0, column: Number(end.column) || 0 },
    },
  }
  if (typeof raw.replacement === "string") match.replacement = raw.replacement
  return match
}

/**
 * Parse ast-grep `--json=compact` stdout (a single JSON array) into matches,
 * applying the match cap. Exposed for unit tests.
 * @param {string} stdout
 * @param {number} [maxMatches]
 * @returns {SgResult}
 */
export function parseSgJson(stdout, maxMatches = DEFAULT_MAX_MATCHES) {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { matches: [], totalMatches: 0 }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return {
      matches: [],
      totalMatches: 0,
      error: `Failed to parse ast-grep output: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!Array.isArray(parsed)) return { matches: [], totalMatches: 0 }
  const all = parsed.map(toMatch).filter((m) => m !== null)
  const totalMatches = all.length
  if (totalMatches > maxMatches) {
    return {
      matches: all.slice(0, maxMatches),
      totalMatches,
      truncated: true,
      truncatedReason: `match limit (${maxMatches})`,
    }
  }
  return { matches: all, totalMatches }
}

/**
 * Run ast-grep. Resolves an `SgResult`; never throws for "no matches" or a
 * missing binary — those are reported in the result so the tool surfaces a
 * clean message.
 * @param {{
 *   pattern: string,
 *   lang: string,
 *   paths?: string[],
 *   globs?: string[],
 *   rewrite?: string,
 *   context?: number,
 *   updateAll?: boolean,
 * }} options
 * @param {{
 *   cwd?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxBuffer?: number,
 *   maxMatches?: number,
 *   sgPath?: string,
 *   spawnImpl?: typeof spawn,
 *   detectImpl?: () => Promise<string | null>,
 * }} [opts]
 * @returns {Promise<SgResult>}
 */
export async function runSg(options, opts = {}) {
  const bin = opts.sgPath ?? (await (opts.detectImpl ?? detectAstGrep)())
  if (!bin) {
    return {
      matches: [],
      totalMatches: 0,
      error:
        "ast-grep is not available. Install it (`@ast-grep/cli`, cargo, scoop, or brew) " +
        "or set COGNIA_AST_GREP_PATH to the binary.",
    }
  }

  const args = buildArgs(options)
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnImpl = opts.spawnImpl ?? spawn

  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(bin, args, {
        cwd: opts.cwd,
        signal: opts.signal,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      resolve({
        matches: [],
        totalMatches: 0,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    let out = ""
    let err = ""
    let truncated = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: "timeout",
        error: `Search timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => {
      if (truncated) return
      out += chunk
      if (out.length > maxBuffer) {
        truncated = true
        out = out.slice(0, maxBuffer)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    })
    child.stderr?.on("data", (chunk) => {
      if (err.length < 16 * 1024) err += chunk
    })
    child.on("error", (e) => {
      finish({ matches: [], totalMatches: 0, error: e instanceof Error ? e.message : String(e) })
    })
    child.on("close", (code) => {
      // ast-grep exits non-zero on a bad pattern/language; a truncated stream
      // killed the child so accept whatever code accompanies it.
      if (truncated) {
        const parsed = parseSgJson(out, opts.maxMatches)
        finish({
          ...parsed,
          truncated: true,
          truncatedReason: parsed.truncatedReason ?? "output size",
          // A truncated SEARCH is just a partial result. A truncated REWRITE
          // means the child was killed mid-`--update-all`: some files may be
          // rewritten and others not. Reporting that as a clean
          // "[APPLIED] changed N matches" is a lie the agent cannot detect.
          ...(opts.updateAll
            ? {
                error:
                  "the rewrite was interrupted by the output-size cap — some files may have been modified and others not. Inspect `git status` / `git diff` before continuing, then re-run with a narrower `paths` or `globs` scope.",
              }
            : {}),
        })
        return
      }
      if (code && code !== 0 && out.trim().length === 0) {
        finish({
          matches: [],
          totalMatches: 0,
          error: err.trim() || `ast-grep exited with code ${code}`,
        })
        return
      }
      finish(parseSgJson(out, opts.maxMatches))
    })
  })
}
