/**
 * `cognia-agent rpc` — start the JSON-RPC 2.0 server over stdin/stdout.
 *
 * Protocol: newline-delimited UTF-8 JSON. One JSON-RPC 2.0 request per line on
 * stdin; responses and `agent.event` notifications on stdout. Diagnostics go to
 * stderr.
 *
 * Usage:
 *   cognia-agent rpc [--model m] [--provider p] [--backend b]
 *
 * The server reads the credential from the CLI config (same as `cognia-agent run`).
 */

import { randomUUID } from "node:crypto"
import os from "node:os"

import type { ParsedArgs } from "./args"
import { boolFlag, stringFlag } from "./args"
import type { OutputSink } from "./output"
import { realOutput } from "./output"
import { loadConfig as defaultLoadConfig, resolveHome } from "../config/load"
import { configureCliLogging as defaultConfigureLogging } from "../config/cli-logging"
import { createAgentRpcServer } from "../agent/rpc/server"
import { createAgentRuntimeService } from "../agent/rpc/runtime-service"

export interface RpcCommandDeps {
  out?: OutputSink
  loadConfig?: typeof defaultLoadConfig
  configureLogging?: typeof defaultConfigureLogging
  createService?: typeof createAgentRuntimeService
  createServer?: typeof createAgentRpcServer
}

const RPC_HELP = `cognia-agent rpc — JSON-RPC 2.0 server

Usage:
  cognia-agent rpc [--model m] [--provider p] [--backend b]

Reads JSON-RPC 2.0 requests from stdin (one per line, newline-delimited JSON).
Writes responses and agent.event notifications to stdout.
Diagnostics go to stderr.

Protocol version: 2
`

export async function rpcCommand(args: ParsedArgs, deps: RpcCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput

  if (args.help) {
    out.write(RPC_HELP)
    return 0
  }

  const config = (deps.loadConfig ?? defaultLoadConfig)()

  const model = stringFlag(args, "model") ?? config.model
  const provider = stringFlag(args, "provider") ?? config.provider
  const backend = stringFlag(args, "backend") ?? config.agentBackend

  const runtimeConfig = {
    ...config,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(backend ? { agentBackend: backend } : {}),
  }
  const home = resolveHome(process.env, os.homedir())
  let service: ReturnType<typeof createAgentRuntimeService> | undefined

  // stdout is the JSON-RPC wire: a single library `[INFO]` line on it breaks
  // client framing (the default console transport writes there). Route every
  // diagnostic to stderr — same headless surface `run` uses — before the
  // service boots the plugin/external-agent stack that produces the noise.
  const restoreLogging = (deps.configureLogging ?? defaultConfigureLogging)({
    surface: "headless",
    verbose: boolFlag(args, "verbose") || boolFlag(args, "debug"),
  })
  try {
    service = (deps.createService ?? createAgentRuntimeService)({
      config: runtimeConfig,
      home,
    })
    const server = (deps.createServer ?? createAgentRpcServer)({
      input: process.stdin,
      output: process.stdout,
      diagnostic: process.stderr,
      service,
      hostVersion: process.env.npm_package_version ?? "0.1.0",
      runtimeVersion: process.env.npm_package_version ?? "0.1.0",
      instanceId: randomUUID(),
    })

    await server.serve()
    return 0
  } catch (err) {
    await service?.close().catch(() => undefined)
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ level: "error", message }) + "\n")
    return 1
  } finally {
    restoreLogging()
  }
}
