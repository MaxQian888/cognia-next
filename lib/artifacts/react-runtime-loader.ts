/**
 * Resolve the offline React artifact runtime that
 * `scripts/build/build-artifact-runtime.mjs` writes into
 * `public/artifact-runtime/`, and run the JSX transform for a preview.
 *
 * Why this exists: React 19 stopped publishing UMD builds, so the
 * `unpkg.com/react@19/umd/*.js` tags the preview shell carried were a
 * permanent 404 and every React artifact preview timed out — in every shell,
 * every time. The runtime is now ours, served same-origin, and committed to
 * the repo the way `public/monaco` is.
 *
 * Two deliberate placements:
 *
 * - **The JSX transform runs in the PARENT, in a Worker.** `@babel/standalone`
 *   is 2.4 MB; putting it in the preview frame meant paying that per artifact
 *   AND granting the frame `'unsafe-eval'`. Here the frame receives plain JS
 *   and needs neither.
 * - **Only the URL crosses into the frame.** Nothing is inlined, so the frame
 *   works under a CSP with no `'unsafe-inline'`.
 *
 * Import this LAZILY (`await import(...)`) — it is only needed to preview a
 * `react` artifact, and a static import would pull the worker plumbing into
 * every shell that merely renders a chart.
 */

import { loggers } from "@cognia/logging"

/** Public path of the committed runtime directory. Mirrors `/monaco/vs`. */
export const ARTIFACT_RUNTIME_BASE = "/artifact-runtime"
export const ARTIFACT_REACT_RUNTIME_PATH = `${ARTIFACT_RUNTIME_BASE}/react-runtime.js`
export const ARTIFACT_SHELL_PATH = `${ARTIFACT_RUNTIME_BASE}/artifact-shell.js`
export const ARTIFACT_JSX_TRANSFORM_PATH = `${ARTIFACT_RUNTIME_BASE}/jsx-transform.js`
export const ARTIFACT_RUNTIME_MANIFEST_PATH = `${ARTIFACT_RUNTIME_BASE}/manifest.json`

export interface ArtifactReactRuntime {
  /** Absolute origin the frame must be allowed to load scripts from. */
  origin: string
  /** Absolute URL of the React + ReactDOM bundle. */
  reactRuntimeUrl: string
  /** Absolute URL of the in-frame bootstrap. */
  shellUrl: string
  /** React version the bundle carries, for diagnostics. */
  reactVersion: string
}

/**
 * Thrown when the committed runtime is not being served. Not recoverable at
 * runtime — there is no CDN fallback, because React 19 ships no UMD build and
 * the packaged desktop shell's CSP names no third-party script origin. The
 * preview surfaces this as "the runtime failed to initialize" and the fix is
 * to run `pnpm artifact-runtime:build`.
 */
export class ArtifactRuntimeUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("The artifact React runtime is not available at /artifact-runtime/")
    this.name = "ArtifactRuntimeUnavailableError"
    this.cause = cause
  }
}

interface RuntimeManifest {
  reactVersion?: unknown
  files?: Record<string, unknown>
}

let runtimePromise: Promise<ArtifactReactRuntime> | null = null

function absolute(path: string): string {
  return new URL(path, window.location.href).toString()
}

async function resolveRuntime(): Promise<ArtifactReactRuntime> {
  let manifest: RuntimeManifest
  try {
    const response = await fetch(absolute(ARTIFACT_RUNTIME_MANIFEST_PATH), { cache: "force-cache" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    manifest = (await response.json()) as RuntimeManifest
  } catch (error) {
    loggers.ui.error("artifacts.react-runtime.missing", error, {
      path: ARTIFACT_RUNTIME_MANIFEST_PATH,
      remedy: "pnpm artifact-runtime:build",
    })
    throw new ArtifactRuntimeUnavailableError(error)
  }
  const files = manifest.files ?? {}
  for (const name of ["react-runtime.js", "artifact-shell.js", "jsx-transform.js"]) {
    if (!files[name]) {
      loggers.ui.error("artifacts.react-runtime.incomplete", undefined, { missing: name })
      throw new ArtifactRuntimeUnavailableError(new Error(`missing ${name}`))
    }
  }
  return {
    origin: new URL(absolute(ARTIFACT_RUNTIME_BASE)).origin,
    reactRuntimeUrl: absolute(ARTIFACT_REACT_RUNTIME_PATH),
    shellUrl: absolute(ARTIFACT_SHELL_PATH),
    reactVersion: typeof manifest.reactVersion === "string" ? manifest.reactVersion : "unknown",
  }
}

/** Memoized: one manifest fetch per session, however many previews open. */
export function loadArtifactReactRuntime(): Promise<ArtifactReactRuntime> {
  runtimePromise ??= resolveRuntime().catch((error) => {
    // Do not cache the failure — a dev who runs the build script mid-session
    // should get a working preview on the next refresh.
    runtimePromise = null
    throw error
  })
  return runtimePromise
}

// ---------------------------------------------------------------- JSX transform

export interface ArtifactJsxTransformResult {
  code: string
  isModule: boolean
}

interface JsxTransformer {
  transform(code: string): ArtifactJsxTransformResult
}

/**
 * A transform FAILURE and a worker failure are different animals: the first is
 * the artifact's own syntax error and must reach the user, the second means the
 * worker is unusable and the main-thread fallback should take over. Folding
 * them together made a syntax error silently load 2.4 MB of Babel and hang.
 */
type TransformOutcome =
  { ok: true; result: ArtifactJsxTransformResult } | { ok: false; message: string }

type PendingTransform = {
  settle: (outcome: TransformOutcome) => void
  fail: (error: Error) => void
}

let workerPromise: Promise<Worker> | null = null
let inlinePromise: Promise<JsxTransformer> | null = null
let nextRequestId = 0
const pending = new Map<number, PendingTransform>()

function startWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(absolute(ARTIFACT_JSX_TRANSFORM_PATH))
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    worker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; id?: number; code?: string; isModule?: boolean; error?: string }
        | undefined
      if (!data || data.type !== "cognia-artifact-jsx-result") return
      const entry = pending.get(data.id ?? -1)
      if (!entry) return
      pending.delete(data.id ?? -1)
      if (data.error) entry.settle({ ok: false, message: data.error })
      else
        entry.settle({
          ok: true,
          result: { code: data.code ?? "", isModule: data.isModule === true },
        })
    })
    worker.addEventListener("error", (event) => {
      // A worker that dies takes every in-flight request with it.
      const failure = new Error(event.message || "artifact JSX worker failed")
      for (const [id, entry] of pending) {
        pending.delete(id)
        entry.fail(failure)
      }
      workerPromise = null
      reject(failure)
    })
    resolve(worker)
  })
}

/**
 * Main-thread fallback. The bundle is dual-context on purpose, so a shell that
 * cannot construct a Worker (or a test environment that has none) still gets a
 * working transform instead of a dead preview.
 */
function loadInlineTransformer(): Promise<JsxTransformer> {
  return new Promise((resolve, reject) => {
    const existing = (globalThis as { CogniaArtifactJsx?: JsxTransformer }).CogniaArtifactJsx
    if (existing) {
      resolve(existing)
      return
    }
    const script = document.createElement("script")
    script.src = absolute(ARTIFACT_JSX_TRANSFORM_PATH)
    script.addEventListener("load", () => {
      const loaded = (globalThis as { CogniaArtifactJsx?: JsxTransformer }).CogniaArtifactJsx
      if (loaded) resolve(loaded)
      else
        reject(new ArtifactRuntimeUnavailableError(new Error("jsx-transform.js exported nothing")))
    })
    script.addEventListener("error", () => {
      reject(new ArtifactRuntimeUnavailableError(new Error("jsx-transform.js failed to load")))
    })
    document.head.appendChild(script)
  })
}

/**
 * Compile artifact JSX to a classic-script-safe bundle. ESM input is
 * downleveled to CommonJS — model-authored React artifacts routinely open with
 * `import React from "react"`, which is a syntax error under script semantics.
 */
export async function transformArtifactJsx(code: string): Promise<ArtifactJsxTransformResult> {
  if (typeof Worker === "function") {
    let outcome: TransformOutcome | null = null
    try {
      workerPromise ??= startWorker()
      const worker = await workerPromise
      const id = nextRequestId++
      outcome = await new Promise<TransformOutcome>((settle, fail) => {
        pending.set(id, { settle, fail })
        worker.postMessage({ type: "cognia-artifact-jsx-transform", id, code })
      })
    } catch (error) {
      loggers.ui.warn("artifacts.react-runtime.worker-unavailable", {
        message: error instanceof Error ? error.message : String(error),
      })
      workerPromise = null
    }
    // Outside the catch on purpose — the artifact's own syntax error must not
    // look like a broken worker and send us down the fallback path.
    if (outcome?.ok === true) return outcome.result
    if (outcome?.ok === false) throw new Error(outcome.message)
  }
  inlinePromise ??= loadInlineTransformer()
  const transformer = await inlinePromise.catch((error) => {
    inlinePromise = null
    throw error
  })
  return transformer.transform(code)
}

/** Test seam — drops the memoized runtime, worker and transformer. */
export function resetArtifactReactRuntimeForTests(): void {
  runtimePromise = null
  inlinePromise = null
  pending.clear()
  nextRequestId = 0
  if (workerPromise) {
    void workerPromise.then((worker) => worker.terminate()).catch(() => undefined)
    workerPromise = null
  }
  delete (globalThis as { CogniaArtifactJsx?: unknown }).CogniaArtifactJsx
}
