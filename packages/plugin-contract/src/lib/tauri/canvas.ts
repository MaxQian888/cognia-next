/**
 * The plugin contract's share of `lib/tauri/canvas.ts`, which re-exports these.
 */
export interface PythonExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}
