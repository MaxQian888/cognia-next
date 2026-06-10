/**
 * Unified code-execution strategy. JS/HTML/CSS run in a sandboxed
 * iframe (web + desktop). Python runs via the Tauri sidecar
 * `canvas_run_python` command (desktop only). All other languages
 * return an "unsupported" result without throwing.
 *
 * This is cognia-next's implementation of the surface Cognia exposes
 * at the same path; the consuming hooks are unchanged.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

export type CodeSandboxKind = "iframe" | "tauri-python" | "unsupported"

export interface UnifiedCodeExecutionResult {
  success: boolean
  sandbox: CodeSandboxKind
  stdout: string
  stderr: string
  exitCode?: number
  durationMs: number
  /** Cognia compatibility — same as durationMs in ms. */
  executionTime?: number
  /** Cognia compatibility — language echoed back from the request. */
  language?: string
  /** When `success === false` and we couldn't execute at all. */
  error?: string
  /** Cognia compatibility — true when result is a mocked / simulated run. */
  isSimulated?: boolean
}

export interface CodeExecutionRequest {
  code: string
  language?: string
  timeoutMs?: number
  /** When set, abort early; consumers re-issue the request to retry. */
  signal?: AbortSignal
  /** Cognia compatibility: lets callers force the desktop path. */
  isDesktop?: boolean
  /** Cognia compatibility: stdin payload for stdin-driven sandboxes. */
  stdin?: string
  /**
   * ADR-0028 Phase 3 — when true, Python runs through the OS sandbox
   * backend (`bwrap` / `sandbox-exec`) instead of a bare interpreter.
   * Driven by the renderer's global sandbox toggle
   * (`AppSettings.sandboxDefaultEnabled`). Ignored by the iframe path
   * (JS/HTML/CSS are already confined to a `sandbox="allow-scripts"`
   * iframe).
   */
  sandboxed?: boolean
}

const DEFAULT_TIMEOUT_MS = 30000

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

async function executeInIframeSandbox(
  req: CodeExecutionRequest
): Promise<UnifiedCodeExecutionResult> {
  if (typeof document === "undefined") {
    return {
      success: false,
      sandbox: "iframe",
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: "iframe sandbox requires a browser document",
    }
  }
  const start = nowMs()
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lang = (req.language ?? "javascript").toLowerCase()

  const iframe = document.createElement("iframe")
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.style.display = "none"
  document.body.appendChild(iframe)

  const cleanup = () => {
    try {
      iframe.remove()
    } catch {
      // Element already detached — ignore.
    }
  }

  const html =
    lang === "html"
      ? req.code
      : lang === "css"
        ? `<style>${req.code}</style>`
        : `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
          (function () {
            const out = []; const err = [];
            const send = (kind, payload) => parent.postMessage({__cogniaCanvas: true, kind, payload}, '*');
            ['log','info','debug'].forEach((m) => { const orig = console[m]; console[m] = (...a) => { out.push(a.map(String).join(' ')); send('stdout', a.map(String).join(' ')); orig.apply(console, a); }; });
            ['warn','error'].forEach((m) => { const orig = console[m]; console[m] = (...a) => { err.push(a.map(String).join(' ')); send('stderr', a.map(String).join(' ')); orig.apply(console, a); }; });
            window.addEventListener('error', (e) => send('stderr', String(e.message)));
            try { ${lang === "javascript" || lang === "typescript" || lang === "jsx" || lang === "tsx" ? req.code : ""} } catch (e) { send('stderr', String(e && e.message ? e.message : e)); }
            send('done', {});
          })();
        </script></body></html>`

  return new Promise<UnifiedCodeExecutionResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finalize = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      window.removeEventListener("message", handler)
      cleanup()
      resolve({
        success: ok,
        sandbox: "iframe",
        stdout,
        stderr,
        durationMs: Math.round(nowMs() - start),
        error,
      })
    }
    const handler = (ev: MessageEvent) => {
      const data = ev.data as { __cogniaCanvas?: boolean; kind?: string; payload?: unknown } | null
      if (!data || !data.__cogniaCanvas) return
      if (data.kind === "stdout") stdout += String(data.payload ?? "") + "\n"
      else if (data.kind === "stderr") stderr += String(data.payload ?? "") + "\n"
      else if (data.kind === "done") finalize(stderr.length === 0)
    }
    window.addEventListener("message", handler)
    req.signal?.addEventListener("abort", () => finalize(false, "aborted"))
    setTimeout(() => finalize(false, `execution timed out after ${timeoutMs}ms`), timeoutMs)
    iframe.srcdoc = html
  })
}

interface TauriPythonResponse {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

async function executePythonViaTauri(
  req: CodeExecutionRequest
): Promise<UnifiedCodeExecutionResult> {
  if (!isTauri()) {
    return {
      success: false,
      sandbox: "unsupported",
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: "Python execution requires the desktop build (Tauri sidecar).",
    }
  }
  const start = nowMs()
  try {
    const res = (await invoke("canvas_run_python", {
      code: req.code,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      sandboxed: req.sandboxed ?? false,
    })) as TauriPythonResponse
    return {
      success: res.exit_code === 0,
      sandbox: "tauri-python",
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exit_code,
      durationMs: res.duration_ms || Math.round(nowMs() - start),
    }
  } catch (err) {
    return {
      success: false,
      sandbox: "tauri-python",
      stdout: "",
      stderr: String(err),
      durationMs: Math.round(nowMs() - start),
      error: String(err),
    }
  }
}

export async function executeCodeWithSandboxPriority(
  req: CodeExecutionRequest
): Promise<UnifiedCodeExecutionResult> {
  const lang = (req.language ?? "javascript").toLowerCase()
  if (lang === "python" || lang === "py") {
    return executePythonViaTauri(req)
  }
  const iframeLanguages = new Set([
    "javascript",
    "js",
    "typescript",
    "ts",
    "jsx",
    "tsx",
    "html",
    "css",
  ])
  if (iframeLanguages.has(lang)) {
    return executeInIframeSandbox(req)
  }
  return {
    success: false,
    sandbox: "unsupported",
    stdout: "",
    stderr: "",
    durationMs: 0,
    error: `Unsupported language for sandbox execution: ${lang}`,
  }
}
