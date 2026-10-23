export interface EntrypointProcess {
  stderr: { write(text: string): unknown }
  exit(code: number): never
  exitCode: number | string | null | undefined
}

/** Load runtime dependencies in production by default: React development
 * tracks retain streamed props in Node's unbounded User Timing buffer.
 * Restore the ambient environment before user commands can spawn children. */
export async function withCliProductionEnvironment<T>(
  load: () => Promise<T>,
  env: Record<string, string | undefined> = process.env
): Promise<T> {
  const original = env.NODE_ENV
  env.NODE_ENV ??= "production"
  try {
    return await load()
  } finally {
    if (original === undefined) delete env.NODE_ENV
    else env.NODE_ENV = original
  }
}

/** Convert Node's permissive exit-code property into the CLI's numeric contract. */
export function normalizeProcessExitCode(exitCode: EntrypointProcess["exitCode"]): number {
  if (exitCode == null) return 0
  if (typeof exitCode === "number") return exitCode
  const parsed = Number(exitCode)
  return Number.isInteger(parsed) ? parsed : 1
}

/**
 * The exit code a fatal error asks for, or 1. An error carries one when its
 * supervisor must tell it apart from a crash: a brain the server refused
 * exits 78 so it is not respawned into the same refusal.
 */
export function fatalExitCode(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code < 256 ? code : 1
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
    proc.exit(fatalExitCode(error))
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
