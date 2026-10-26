/**
 * The plugin contract's share of `lib/terminal/script-runner.ts`, which re-exports these.
 */
export interface ScriptType {
  /** Logical language/kind label (drives UI + telemetry). */
  kind: string
  /** Interpreter binary to spawn. */
  interpreter: string
  /** Args inserted before the script path (e.g. `-NoLogo -File` for ps1). */
  interpreterArgs: string[]
}
