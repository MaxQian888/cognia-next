/**
 * Tauri-side Canvas helpers. Currently exposes the Python sandbox.
 */

import { transport } from "@/lib/tauri"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

export interface PythonExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export async function runPython(code: string, timeoutMs?: number): Promise<PythonExecResult> {
  // Plugin host: announce start / completion / error of every Python sandbox
  // run. The Tauri sandbox is single-language, so the dispatch tag is fixed
  // to "python"; the optional `sandboxId` is intentionally unused here —
  // future multi-sandbox runners can pass one through `transport.call`.
  const hooks = getPluginEventHooks()
  hooks.dispatchCodeExecutionStart("python", code)
  try {
    const result = await transport.call<PythonExecResult>("canvas_run_python", { code, timeoutMs })
    hooks.dispatchCodeExecutionComplete("python", result)
    return result
  } catch (err) {
    hooks.dispatchCodeExecutionError("python", err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}
