/**
 * The plugin contract's share of `lib/native/external-agent.ts`, which re-exports these.
 */
import type { ExternalAgentProcessSandboxPolicy } from "@cognia/agent-contracts/external-agent"
import type { SandboxPlacement } from "../../types/sandbox/environment-spec"

/** External agent spawn configuration */
export interface ExternalAgentSpawnConfig {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sandboxPolicy?: ExternalAgentProcessSandboxPolicy
  /**
   * How the host delivers stdout. Defaults to `"line"` (stripped lines on
   * `external-agent://stdout`); `"raw"` forwards undecoded base64 chunks on
   * `external-agent://stdout-raw`.
   *
   * Only `pi-rpc` opts into `"raw"` — its JSONL frames are delimited by the
   * `\n` byte alone and its adapter owns a strict LF codec with frame/buffer
   * ceilings that pre-split lines would put out of reach. Mirrors
   * `ExternalAgentStdoutFraming` in
   * `crates/cognia-external-agent/src/process.rs` and
   * `cli/src/runtime/external/node-backend.ts`.
   */
  framing?: "line" | "raw"
  /**
   * Run the agent in the project's runtime environment instead of this host's
   * own execution path (ADR-0182).
   *
   * Absent on every spawn that resolved no environment, which is every spawn
   * before a project opts in. Set from the pending-placement registry by
   * `spawnExternalAgent` rather than by callers, because the placement belongs
   * to the run and this config is the agent's.
   */
  sandbox?: SandboxPlacement
}

/** Terminal state */
export type TerminalState =
  | { type: "Running" }
  | { type: "Exited"; code: number }
  | { type: "Killed" }
  | { type: "Error"; message: string }

/** Terminal output result */
export interface TerminalExitStatus {
  exitCode: number | null
  signal: string | null
}

/** Terminal output result */
export interface TerminalOutputResult {
  output: string
  truncated: boolean
  exitStatus: TerminalExitStatus
  exitCode?: number | null
}

/** Terminal info */
export interface TerminalInfo {
  id: string
  sessionId: string
  command: string
  state: TerminalState
  exitCode: number | null
  exitStatus?: TerminalExitStatus
}
