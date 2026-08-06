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

import type { ParsedArgs } from "./args"
import { stringFlag } from "./args"
import type { OutputSink } from "./output"
import { realOutput } from "./output"
import { loadConfig as defaultLoadConfig } from "../config/load"
import { createRpcServer } from "@/packages/agent/src/rpc/server"
import type { CogniaRuntimeOptions } from "@/packages/agent/src/runtime"

export interface RpcCommandDeps {
  out?: OutputSink
  loadConfig?: typeof defaultLoadConfig
}

const RPC_HELP = `cognia-agent rpc — JSON-RPC 2.0 server

Usage:
  cognia-agent rpc [--model m] [--provider p] [--backend b]

Reads JSON-RPC 2.0 requests from stdin (one per line, newline-delimited JSON).
Writes responses and agent.event notifications to stdout.
Diagnostics go to stderr.

Protocol version: 1
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

  // Determine credential from config — the RPC server uses the same credential
  // resolution as `cognia-agent run`.
  const runtimeOptions: CogniaRuntimeOptions = {
    credential: config.credentialRef ?? { credentialEnv: "ANTHROPIC_API_KEY" },
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(backend ? { backend } : {}),
  }

  try {
    const server = await createRpcServer({
      runtimeOptions,
      input: process.stdin,
      output: process.stdout,
      diagnostic: process.stderr,
    })

    await server.serve()
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ level: "error", message }) + "\n")
    return 1
  }
}
