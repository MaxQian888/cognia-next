/**
 * `cognia-status-probe` entry point (bundled to dist/cognia-status-probe.mjs).
 *
 *   cognia-status-probe run    --config <file>   probe + ingestion (+ mirror if enabled)
 *   cognia-status-probe mirror --config <file>   read-only mirror only
 *   cognia-status-probe --version
 *
 * Exit codes: 0 clean shutdown, 2 usage/config error, 1 unexpected failure.
 */

import {
  ConfigError,
  loadProbeSecret,
  parseMirrorOnlyConfig,
  parseProbeConfig,
  readConfigFile,
} from "./config"
import { createLogger, type Logger } from "./logger"
import { startMirror, type RunningMirror } from "./mirror"
import { ProbeRunner } from "./runner"
import { createNodeTransport } from "./transport"

declare const __PROBE_VERSION__: string
export const PROBE_VERSION = typeof __PROBE_VERSION__ === "string" ? __PROBE_VERSION__ : "dev"

const USAGE = `Usage:
  cognia-status-probe run --config <file>
  cognia-status-probe mirror --config <file>
  cognia-status-probe --version`

export interface ParsedArgs {
  command: "run" | "mirror" | "version" | "help"
  configFile: string | null
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  if (command === "--version" || command === "version")
    return { command: "version", configFile: null }
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { command: "help", configFile: null }
  }
  if (command !== "run" && command !== "mirror")
    throw new ConfigError(`unknown command: ${command}`)
  let configFile: string | null = null
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === "--config" || arg === "-c") {
      configFile = rest[index + 1] ?? null
      index += 1
    } else if (arg?.startsWith("--config=")) {
      configFile = arg.slice("--config=".length)
    } else {
      throw new ConfigError(`unknown argument: ${arg}`)
    }
  }
  if (!configFile) throw new ConfigError("--config <file> is required")
  return { command, configFile }
}

/** Resolve once SIGTERM or SIGINT arrives. */
function shutdownSignal(logger: Logger): Promise<string> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      logger.info("shutdown_requested", { signal })
      process.off("SIGTERM", onSignal)
      process.off("SIGINT", onSignal)
      resolve(signal)
    }
    process.on("SIGTERM", onSignal)
    process.on("SIGINT", onSignal)
  })
}

async function commandRun(configFile: string, logger: Logger): Promise<void> {
  const config = parseProbeConfig(await readConfigFile(configFile))
  const { secret, permissive } = await loadProbeSecret(config.secretFile)
  if (permissive) logger.warn("secret_file_permissive", { hint: "chmod 600 the probe secret file" })
  const userAgent = `cognia-status-probe/${PROBE_VERSION}`
  const runner = new ProbeRunner({
    config,
    secret,
    transport: createNodeTransport({ userAgent }),
    logger,
    userAgent,
  })
  let mirror: RunningMirror | null = null
  const stopping = shutdownSignal(logger)
  await runner.start()
  if (config.mirror?.enabled) mirror = await startMirror(config.mirror, logger)
  await stopping
  await Promise.all([runner.stop(), mirror?.stop()])
}

async function commandMirror(configFile: string, logger: Logger): Promise<void> {
  const config = parseMirrorOnlyConfig(await readConfigFile(configFile))
  const stopping = shutdownSignal(logger)
  const mirror = await startMirror(config.mirror, logger)
  await stopping
  await mirror.stop()
}

export async function main(argv: string[], logger: Logger = createLogger()): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.command === "version") {
      process.stdout.write(`${PROBE_VERSION}\n`)
      return 0
    }
    if (args.command === "help") {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    logger.info("starting", { command: args.command, version: PROBE_VERSION })
    if (args.command === "run") await commandRun(args.configFile!, logger)
    else await commandMirror(args.configFile!, logger)
    return 0
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("config_error", { message: error.message })
      process.stderr.write(`${error.message}\n${USAGE}\n`)
      return 2
    }
    logger.error("fatal", { error: error instanceof Error ? error.name : "unknown" })
    return 1
  }
}
