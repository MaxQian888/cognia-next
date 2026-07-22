// web-clone orchestration: normalize a snapshot/convert request, confine the
// output path under the caller's workspace, pre-validate the entry URL against
// the SSRF gate, then run the vendored engine as an ISOLATED child process
// (`webclone/dist/runner.js`). The child owns its own stdio, so the engine's
// progress chatter (which it writes to stdout) can never corrupt the sidecar's
// JSON-RPC channel — it is rerouted to the child's stderr and discarded here.
//
// All side effects (spawn, fs, clock, randomness) are injectable so the suite
// runs hermetically without spawning a real Node process.

import { spawn as defaultSpawn } from "node:child_process"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

import { assertPathInside } from "../safety.mjs"
import {
  DEFAULTS as ENGINE_DEFAULTS,
  evaluateFetchTarget,
  parseCodegenFramework,
  parseFrameworkHint,
  validateOptions,
} from "../../webclone/dist/index.js"

/** Absolute path to the vendored engine's runner (built by `tsc`). */
export const RUNNER_PATH = fileURLToPath(new URL("../../webclone/dist/runner.js", import.meta.url))

/** Cap the engine's captured stderr chatter so a runaway page can't balloon memory. */
const MAX_STDERR_BYTES = 64 * 1024
/** Default hard ceiling for one snapshot job. Snapshots are heavy but bounded. */
export const DEFAULT_JOB_TIMEOUT_MS = 180 * 1000

export const SNAPSHOT_MODES = Object.freeze(["single", "bundle"])
export const CODEGEN_FRAMEWORKS = Object.freeze([...ENGINE_DEFAULTS.codegenFrameworks])
export const FRAMEWORK_HINTS = Object.freeze([...ENGINE_DEFAULTS.frameworkHints])

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Build the full engine `SnapshotOptions` + runner job from tool args, confining
 * the output path under `cwd`. Throws on invalid input (bad path, bad mode).
 *
 * @param {{
 *   cwd: string,
 *   url?: string,
 *   convertLocal?: string,
 *   output: string,
 *   mode?: string,
 *   extractComponents?: boolean,
 *   framework?: string,
 *   frameworkHint?: string,
 *   maxAssets?: number,
 *   concurrency?: number,
 *   timeout?: number,
 *   maxFileSize?: number,
 *   allowPrivateHosts?: boolean,
 *   pretty?: boolean,
 *   codegenTypescript?: boolean,
 *   codegenGenerateDrafts?: boolean,
 *   codegenExtractShared?: boolean,
 * }} args
 * @returns {{ mode: 'snapshot' | 'convert', url?: string, options: object }}
 */
export function buildJob(args) {
  if (!args || typeof args.cwd !== "string" || args.cwd.length === 0) {
    throw new Error("cwd (absolute workspace path) is required")
  }
  if (typeof args.output !== "string" || args.output.length === 0) {
    throw new Error("output path is required")
  }
  const isConvert = typeof args.convertLocal === "string" && args.convertLocal.length > 0
  if (!isConvert && (typeof args.url !== "string" || args.url.length === 0)) {
    throw new Error(
      "url is required for a snapshot (or pass convertLocal to run codegen on a local output)"
    )
  }

  const mode = args.mode ?? ENGINE_DEFAULTS.mode
  if (!SNAPSHOT_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${SNAPSHOT_MODES.join(", ")} (got "${mode}")`)
  }
  const framework = parseCodegenFramework(args.framework)
  if (args.framework != null && !framework) {
    throw new Error(
      `framework must be one of ${CODEGEN_FRAMEWORKS.join(", ")} (got "${args.framework}")`
    )
  }
  const frameworkHint = parseFrameworkHint(args.frameworkHint)
  if (args.frameworkHint != null && !frameworkHint) {
    throw new Error(
      `frameworkHint must be one of ${FRAMEWORK_HINTS.join(", ")} (got "${args.frameworkHint}")`
    )
  }

  // Confine the output under the caller's workspace root (path-traversal guard).
  const output = assertPathInside(args.cwd, args.output)
  // A framework request implies component extraction.
  const wantsCodegen = framework != null
  const extractComponents = Boolean(args.extractComponents) || wantsCodegen

  /** @type {Record<string, unknown>} */
  const options = {
    url: isConvert ? undefined : args.url,
    output,
    mode,
    maxAssets: clampInt(args.maxAssets, ENGINE_DEFAULTS.maxAssets, 1, 5000),
    concurrency: clampInt(args.concurrency, ENGINE_DEFAULTS.concurrency, 1, 32),
    timeout: clampInt(args.timeout, ENGINE_DEFAULTS.timeout, 1000, 120000),
    retryCount: ENGINE_DEFAULTS.retryCount,
    retryInitialDelay: ENGINE_DEFAULTS.retryInitialDelay,
    retryMaxDelay: ENGINE_DEFAULTS.retryMaxDelay,
    inline: ENGINE_DEFAULTS.inline,
    pretty: Boolean(args.pretty),
    extractComponents,
    allowPrivateHosts: Boolean(args.allowPrivateHosts),
  }
  if (frameworkHint != null) options.frameworkHint = frameworkHint
  if (typeof args.maxFileSize === "number")
    options.maxFileSize = clampInt(args.maxFileSize, 0, 0, 1024 * 1024 * 1024)
  if (wantsCodegen) {
    options.frameworkCodegen = {
      framework,
      typescript: args.codegenTypescript !== false,
      cssModules: false,
      generateDrafts: Boolean(args.codegenGenerateDrafts),
      extractSharedLogic: Boolean(args.codegenExtractShared),
    }
  }
  if (isConvert) {
    const convertLocal = assertPathInside(args.cwd, args.convertLocal)
    options.convertLocal = convertLocal
    validateOptions(options)
    return { mode: "convert", options }
  }
  validateOptions(options)
  return { mode: "snapshot", url: args.url, options }
}

function defaultDeps() {
  return {
    spawn: defaultSpawn,
    runnerPath: RUNNER_PATH,
    nodeExec: process.execPath,
    tmpDir: os.tmpdir(),
    randomId: () => randomUUID(),
    fs: {
      writeFile: (p, c) => fsp.writeFile(p, c, "utf8"),
      unlink: (p) => fsp.unlink(p).catch(() => undefined),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }),
    },
  }
}

/**
 * Spawn the runner as a child process, feeding it a job file. Resolves with the
 * parsed {@link import('../../webclone/src/runner').RunnerEnvelope}. Never throws
 * for a snapshot failure — the engine reports failures inside the envelope; only
 * infrastructure faults (spawn error, unparseable output) surface as a thrown
 * error the tool layer maps to `toolError`.
 *
 * @param {{ mode: string, url?: string, options: object }} job
 * @param {Partial<ReturnType<typeof defaultDeps>> & { timeoutMs?: number }} [injected]
 */
export async function runEngine(job, injected = {}) {
  const deps = { ...defaultDeps(), ...injected }
  const timeoutMs = injected.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
  const jobPath = path.join(deps.tmpDir, `webclone-job-${deps.randomId()}.json`)
  await deps.fs.writeFile(jobPath, JSON.stringify(job))

  try {
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = deps.spawn(deps.nodeExec, [deps.runnerPath, jobPath], { windowsHide: true })
      let out = ""
      let err = ""
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }, timeoutMs)
      child.stdout?.on("data", (d) => {
        out += String(d)
      })
      child.stderr?.on("data", (d) => {
        if (err.length < MAX_STDERR_BYTES) err += String(d)
      })
      child.on("error", (e) => {
        clearTimeout(timer)
        resolve({
          code: -1,
          stdout: out,
          stderr: `spawn error: ${e instanceof Error ? e.message : String(e)}`,
        })
      })
      child.on("close", (c) => {
        clearTimeout(timer)
        resolve({ code: killed ? 124 : c, stdout: out, stderr: err })
      })
    })

    if (code === 124) {
      throw new Error(`web-clone runner timed out after ${timeoutMs}ms`)
    }
    const line = stdout.trim().split("\n").filter(Boolean).pop()
    if (!line) {
      throw new Error(
        `web-clone runner produced no result (exit ${code}). ${stderr.slice(-500) || "no stderr"}`
      )
    }
    let envelope
    try {
      envelope = JSON.parse(line)
    } catch {
      throw new Error(`web-clone runner returned unparseable output: ${line.slice(0, 300)}`)
    }
    return envelope
  } finally {
    await deps.fs.unlink(jobPath)
  }
}

/**
 * High-level entry used by the tool handlers: build the job, pre-validate the
 * entry URL (fast, no I/O), and run the engine. Returns the envelope.
 *
 * @param {Parameters<typeof buildJob>[0]} args
 * @param {Partial<ReturnType<typeof defaultDeps>> & { timeoutMs?: number }} [injected]
 */
export async function snapshotSite(args, injected = {}) {
  const job = buildJob(args)
  if (job.mode === "snapshot") {
    const decision = evaluateFetchTarget(job.url, {
      allowPrivateHosts: job.options.allowPrivateHosts,
    })
    if (!decision.allowed) {
      return {
        ok: false,
        error: {
          name: "FetchTargetBlockedError",
          message:
            decision.reason === "private-host"
              ? `Refusing to fetch a private/loopback address (${decision.host}). Set allowPrivateHosts to override.`
              : decision.reason === "bad-scheme"
                ? `Refusing to fetch non-http(s) URL: ${job.url}`
                : `Refusing to fetch an unparseable URL: ${job.url}`,
          reason: decision.reason,
        },
      }
    }
  }
  return runEngine(job, injected)
}
