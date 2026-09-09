/**
 * Console-log discipline for the CLI's user-facing surfaces.
 *
 * `@cognia/logging` attaches a console transport by default, and every library
 * the CLI shares with the desktop app logs through it: the plugin manager
 * alone prints a dozen `[INFO] [plugin:…] activated` / `[DEBUG] [plugin:manager]`
 * lines while it boots. Under `cognia-agent -p` those lines land on STDOUT,
 * ahead of the model's answer, so `cognia-agent -p "…" | jq` and every other
 * pipe consumer reads log noise as the reply. In the Ink TUI the same lines
 * are painted above the app by Ink's console patch.
 *
 * This module swaps that transport for a CLI sink that
 *   - writes to STDERR (headless / readline) or through the console (TUI, so
 *     Ink keeps the screen coherent), never to the answer stream, and
 *   - drops everything below `warn` unless the operator asked for more with
 *     `--verbose` (or `COGNIA_LOG_LEVEL`), mirroring Claude Code's `--verbose`.
 *
 * `serve` (the supervised headless brain) is deliberately NOT routed here: its
 * supervisor consumes the console transport's lines and stamps its own clock.
 */
import {
  addTransport,
  getLoggerConfig,
  removeTransport,
  updateLoggerConfig,
  type LogLevel,
  type StructuredLogEntry,
  type Transport,
} from "@cognia/logging"

/** Name the CLI sink registers under (the built-in one is `console`). */
export const CLI_LOG_TRANSPORT = "cli-console"

const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

/** Which user-facing surface owns stdout right now. */
export type CliLogSurface = "headless" | "repl" | "tui"

export interface CliLoggingOptions {
  surface: CliLogSurface
  /** `--verbose` / `--debug`: show info + debug diagnostics too. */
  verbose?: boolean
  /** Environment to read `COGNIA_LOG_LEVEL` from (defaults to `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
  /** Where a formatted line goes, defaulting per surface (see {@link defaultSink}). */
  sink?: (line: string) => void
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
}

/**
 * The minimum level the CLI sink shows. `COGNIA_LOG_LEVEL` (a logging level
 * name) is the operator's explicit answer, `--verbose` asks for `debug`, and
 * the quiet default is `warn`: a plugin activating is not something a person
 * running a one-shot turn needs to read.
 */
export function resolveCliConsoleLevel(
  options: Pick<CliLoggingOptions, "verbose" | "env">
): LogLevel {
  const env = options.env ?? process.env
  const requested = env.COGNIA_LOG_LEVEL?.trim().toLowerCase()
  if (isLogLevel(requested)) return requested
  return options.verbose ? "debug" : "warn"
}

/** `[WARN] [plugin:manager] message {"arg":"…"}`: one line, no clock, no icons. */
export function formatCliLogLine(
  entry: Pick<StructuredLogEntry, "level" | "module" | "message" | "data">
): string {
  const parts = [`[${entry.level.toUpperCase()}]`]
  if (entry.module) parts.push(`[${entry.module}]`)
  parts.push(entry.message)
  if (entry.data && Object.keys(entry.data).length > 0) {
    try {
      parts.push(JSON.stringify(entry.data))
    } catch {
      parts.push("[unserializable data]")
    }
  }
  return parts.join(" ")
}

/** A `Transport` that formats each entry at or above `minLevel` and hands it to `sink`. */
export function createCliLogTransport(options: {
  minLevel: LogLevel
  sink: (line: string) => void
}): Transport {
  return {
    name: CLI_LOG_TRANSPORT,
    log(entry) {
      if (LEVEL_RANK[entry.level] < LEVEL_RANK[options.minLevel]) return
      try {
        options.sink(formatCliLogLine(entry))
      } catch {
        // A closed stderr (EPIPE) must never take the turn down with it.
      }
    },
  }
}

/**
 * Default sink per surface. Headless and the readline REPL own stdout for the
 * answer, so diagnostics go to stderr. The Ink TUI patches the console and
 * repaints around anything written through it, whereas a raw stderr write
 * would tear the screen, so it goes through `console.error`.
 */
export function defaultSink(surface: CliLogSurface): (line: string) => void {
  if (surface === "tui") return (line) => globalThis.console.error(line)
  return (line) => {
    process.stderr.write(`${line}\n`)
  }
}

/**
 * Replace the library console transport with the CLI sink. Returns a restore
 * that re-attaches whatever was configured before, for callers that hand the
 * process on (tests, the TUI returning to a shell).
 */
export function configureCliLogging(options: CliLoggingOptions): () => void {
  const previous = getLoggerConfig()
  const minLevel = resolveCliConsoleLevel(options)
  const sink = options.sink ?? defaultSink(options.surface)
  updateLoggerConfig({ enableConsole: false })
  removeTransport(CLI_LOG_TRANSPORT)
  addTransport(createCliLogTransport({ minLevel, sink }))
  return () => {
    removeTransport(CLI_LOG_TRANSPORT)
    updateLoggerConfig({ enableConsole: previous.enableConsole })
  }
}
