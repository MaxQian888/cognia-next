/**
 * Tauri-side Canvas helpers. Currently exposes the Python sandbox.
 */

import { transport } from "@/lib/tauri"

export interface PythonExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export async function runPython(code: string, timeoutMs?: number): Promise<PythonExecResult> {
  return transport.call<PythonExecResult>("canvas_run_python", { code, timeoutMs })
}
