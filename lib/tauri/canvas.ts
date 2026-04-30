/**
 * Tauri-side Canvas helpers. Currently exposes the Python sandbox.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

export interface PythonExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export async function runPython(code: string, timeoutMs?: number): Promise<PythonExecResult> {
  if (!isTauri()) {
    throw new Error("canvas_run_python requires the Tauri desktop runtime")
  }
  return await invoke<PythonExecResult>("canvas_run_python", { code, timeoutMs })
}
