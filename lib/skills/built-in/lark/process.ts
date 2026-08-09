import { isTauri } from "@/lib/native/utils"
import {
  acpTerminalCreate,
  acpTerminalKill,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalWaitForExit,
} from "@/lib/native/external-agent"

export interface LarkCliProcessOptions {
  env?: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

export interface LarkCliProcessResult {
  stdout: string
  stderr: string
  exitCode?: number
  timedOut?: boolean
  notFound?: boolean
  truncated?: boolean
}

export type LarkCliProcessRunner = (
  binary: string,
  args: readonly string[],
  options: LarkCliProcessOptions
) => Promise<LarkCliProcessResult>

let runnerOverride: LarkCliProcessRunner | null = null

export function __setLarkCliProcessRunnerForTests(runner: LarkCliProcessRunner | null): void {
  runnerOverride = runner
}

/** Execute lark-cli through the desktop process bridge and fail closed on the web. */
export async function runLarkCliProcess(
  binary: string,
  args: readonly string[],
  options: LarkCliProcessOptions
): Promise<LarkCliProcessResult> {
  if (runnerOverride) return runnerOverride(binary, args, options)
  if (isTauri()) return runTauriProcess(binary, args, options)
  return {
    stdout: "",
    stderr: "lark-cli is available only from the Cognia desktop host.",
    notFound: true,
  }
}

async function runTauriProcess(
  binary: string,
  args: readonly string[],
  options: LarkCliProcessOptions
): Promise<LarkCliProcessResult> {
  let terminalId: string
  try {
    terminalId = await acpTerminalCreate(
      "cognia:lark-cli",
      binary,
      [...args],
      undefined,
      options.env,
      options.maxOutputBytes
    )
  } catch (error) {
    return { stdout: "", stderr: String(error), notFound: true }
  }

  try {
    let timedOut = false
    let exitCode: number | undefined
    try {
      const wait = await acpTerminalWaitForExit(terminalId, options.timeoutMs)
      exitCode = wait.exitStatus.exitCode ?? undefined
    } catch {
      timedOut = true
      await acpTerminalKill(terminalId).catch(() => undefined)
    }
    const output = await acpTerminalOutput(terminalId, options.maxOutputBytes)
    return {
      stdout: output.output,
      stderr: "",
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(output.truncated ? { truncated: true } : {}),
    }
  } finally {
    await acpTerminalRelease(terminalId).catch(() => undefined)
  }
}
