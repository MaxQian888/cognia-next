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
import { injectFrameCsp, injectFrameHead, serializeFrameCsp } from "@/lib/security/frame-csp"

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
const CANVAS_FRAME_CSP = serializeFrameCsp([
  ["default-src", "'none'"],
  ["script-src", "'unsafe-inline' 'unsafe-eval'"],
  ["style-src", "'unsafe-inline'"],
  ["img-src", "data: blob:"],
  ["font-src", "data:"],
  ["media-src", "data: blob:"],
  ["connect-src", "'none'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
])

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
  const nonce =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  const iframe = document.createElement("iframe")
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.dataset.canvasNonce = nonce
  iframe.style.display = "none"
  document.body.appendChild(iframe)

  const cleanup = () => {
    try {
      iframe.remove()
    } catch {
      // Element already detached — ignore.
    }
  }

  const nonceLiteral = JSON.stringify(nonce)
  const bootstrap = `<script>(function(){
    const nonce=${nonceLiteral};
    let done=false;
    const send=(kind,payload)=>parent.postMessage({__cogniaCanvas:true,nonce,kind,payload},'*');
    const stringify=(args)=>args.map((value)=>{try{return typeof value==='string'?value:JSON.stringify(value)}catch{return String(value)}}).join(' ');
    ['log','info','debug'].forEach((method)=>{const original=console[method];console[method]=(...args)=>{send('stdout',stringify(args));original.apply(console,args)}});
    ['warn','error'].forEach((method)=>{const original=console[method];console[method]=(...args)=>{send('stderr',stringify(args));original.apply(console,args)}});
    window.addEventListener('error',(event)=>send('stderr',String(event.message||event.error||'Script error')));
    window.addEventListener('unhandledrejection',(event)=>send('stderr',String(event.reason||'Unhandled rejection')));
    window.addEventListener('load',()=>setTimeout(()=>{if(!done){done=true;send('done',null)}},0),{once:true});
  })();</script>`
  const userMarkup =
    lang === "html"
      ? req.code
      : lang === "css"
        ? `<style>${req.code.replace(/<\/style/gi, "<\\/style")}</style>`
        : `<script>eval(${JSON.stringify(req.code).replaceAll("<", "\\u003c")});</script>`
  const html = injectFrameCsp(injectFrameHead(userMarkup, bootstrap), CANVAS_FRAME_CSP)

  return new Promise<UnifiedCodeExecutionResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const handleAbort = () => finalize(false, "aborted")
    const finalize = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      window.removeEventListener("message", handler)
      req.signal?.removeEventListener("abort", handleAbort)
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
      const data = ev.data as {
        __cogniaCanvas?: boolean
        nonce?: string
        kind?: string
        payload?: unknown
      } | null
      if (ev.source !== iframe.contentWindow) return
      if (!data || !data.__cogniaCanvas || data.nonce !== nonce) return
      if (data.kind === "stdout") stdout += String(data.payload ?? "") + "\n"
      else if (data.kind === "stderr") stderr += String(data.payload ?? "") + "\n"
      else if (data.kind === "done") finalize(stderr.length === 0)
    }
    const timeoutId = setTimeout(
      () => finalize(false, `execution timed out after ${timeoutMs}ms`),
      timeoutMs
    )
    window.addEventListener("message", handler)
    req.signal?.addEventListener("abort", handleAbort, { once: true })
    iframe.srcdoc = html
    if (req.signal?.aborted) handleAbort()
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
  const iframeLanguages = new Set(["javascript", "js", "html", "css"])
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
