export interface EntrypointProcess {
  stderr: { write(text: string): unknown }
  exit(code: number): never
  exitCode: number | string | null | undefined
}

/** Convert Node's permissive exit-code property into the CLI's numeric contract. */
export function normalizeProcessExitCode(exitCode: EntrypointProcess["exitCode"]): number {
  if (exitCode == null) return 0
  if (typeof exitCode === "number") return exitCode
  const parsed = Number(exitCode)
  return Number.isInteger(parsed) ? parsed : 1
}

/**
 * Settle the executable process after boot. Fatal startup failures must use
 * `exit()` rather than only setting `exitCode`: database and runtime imports
 * may already own live timers that would otherwise strand the process until
 * the native supervisor's readiness watchdog fires.
 */
export async function runProcessEntrypoint(
  boot: () => Promise<number>,
  proc: EntrypointProcess = process,
  options: { forceExitOnSuccess?: boolean } = {}
): Promise<void> {
  let code: number
  try {
    code = await boot()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    proc.stderr.write(`cognia-agent: fatal: ${message}\n`)
    proc.exit(1)
  }
  proc.exitCode = code
  if (options.forceExitOnSuccess) proc.exit(code)
}

/** The `on("error", …)` surface of a `process.stdout`/`stderr` socket. */
interface PipeEnd {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * `run … | head -5` closes our stdout mid-stream; the next write then raises
 * EPIPE as an 'error' EVENT on the socket — never an exception `write()` can
 * return — which Node reports as a fatal "unhandled 'error' event" stack.
 * Unix tools die quietly on SIGPIPE; a Node CLI should do the same rather
 * than dump a stack over a closed consumer. Non-EPIPE stream faults still
 * throw, so a genuinely broken channel stays loud.
 */
export function installClosedPipeHandler(proc: {
  stdout: PipeEnd
  stderr: PipeEnd
  exit(code: number): never
}): void {
  const onClosedPipe = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") proc.exit(0)
    else throw error
  }
  proc.stdout.on("error", onClosedPipe)
  proc.stderr.on("error", onClosedPipe)
}
