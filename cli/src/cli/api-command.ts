/**
 * `cognia-agent api ...`, the complete surface over a Cognia Host's command
 * plane.
 *
 * Everything the host exposes is reachable here without the CLI having to
 * grow a hand-written command per RPC, because the generated index already
 * describes every command's fields, risk, approval and wire. `api call` is
 * the floor. `api list` / `describe` / `schema` exist so the floor is
 * discoverable rather than something you need the OpenAPI spec open to use.
 */

import os from "node:os"

import { parseArgv, stringFlag, type ParsedArgs } from "./args"
import { EXIT_OK, EXIT_USAGE, emitFailure, usageFailure, type CliFailure } from "./errors"
import { emitResult, resolveOutputOptions, type OutputOptions } from "./format"
import { realOutput, type OutputSink } from "./output"
import { connectHost, type ConnectDeps } from "../api/connect"
import {
  commandGroups,
  findCommand,
  listCommands,
  suggestCommands,
  type ApiCommandEntry,
} from "../api/catalog"
import { invokeCommand, preflight } from "../api/invoke"
import { buildRequestBody, parseDataFlag, requestTemplate } from "../api/validate"
import type { HostTransport } from "../api/transport"
import { resolveHost, type HostResolution } from "../host/resolve"
import { resolveHome } from "../config/load"

export const API_HELP = `cognia-agent api - call any command a Cognia Host exposes

Usage:
  cognia-agent api call <command> [--data JSON|@file|-] [--<field> value ...] [--wait]
  cognia-agent api list [--group g] [--wire internal|http] [--capability c]
                        [--risk low|high|critical] [--approval none|interactive|signed-policy]
                        [--search text]
  cognia-agent api groups [--wire internal|http]
  cognia-agent api describe <command>
  cognia-agent api schema <command> [--template]
  cognia-agent api request <METHOD> <path> [--data JSON|@file|-]

Host selection:
  --host <name> / --profile <name>  a saved host (or COGNIA_PROFILE)
  --endpoint <url>                  an explicit base URL (or COGNIA_ENDPOINT)
  --tenant <id>                     tenant for the device wire (or COGNIA_TENANT_ID)

Output:
  --format raw|json|pretty  compact JSON | indented JSON | rendered (default pretty)
  -o, --output <dir>        write the result into <dir> instead of stdout (implies raw)
  --timeout <30s|1m|500ms>  per-request budget (default 30s)
  --debug                   log the request envelope to stderr
  --json                    alias for --format raw

Wires:
  internal  POST /internal/_rpc/{name}, loopback service token, every command
  http      POST /api/_rpc/{name}, DPoP device session, execution and host-admin
            commands only, with capability grants and approvals enforced
`

export interface ApiCommandDeps {
  out?: OutputSink
  /** The process argv slice, so a command's own boolean fields can be parsed. */
  argv?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  connect?: typeof connectHost
  resolve?: typeof resolveHost
  connectDeps?: ConnectDeps
  sleep?: (ms: number) => Promise<void>
}

function projectRow(entry: ApiCommandEntry): Record<string, unknown> {
  return {
    command: entry.name,
    group: entry.group,
    action: entry.action,
    wires: entry.wires.join("+"),
    capability: entry.capability,
    risk: entry.risk,
    approval: entry.approval,
  }
}

function describeEntry(entry: ApiCommandEntry): Record<string, unknown> {
  return {
    command: entry.name,
    resource: entry.action.length > 0 ? `${entry.group} ${entry.action}` : entry.group,
    ...(entry.description ? { description: entry.description } : {}),
    target: entry.target,
    capability: entry.capability,
    risk: entry.risk,
    approval: entry.approval,
    idempotency: entry.idempotency,
    wires: entry.wires.join(", "),
    body: entry.bodyKind,
    ...(entry.requireOneOf
      ? { requireOneOf: entry.requireOneOf.map((group) => group.join(" or ")) }
      : {}),
    fields: entry.flags.map((flag) => ({
      field: flag.name,
      flag: flag.flag.length > 0 ? `--${flag.flag}` : "(use --data)",
      type: flag.type,
      required: flag.required ? "yes" : "",
      ...(flag.nullable ? { nullable: "yes" } : {}),
      ...(flag.enum ? { allowed: flag.enum.join(", ") } : {}),
      ...(flag.description ? { description: flag.description } : {}),
    })),
  }
}

function unknownCommandFailure(name: string): CliFailure {
  const suggestions = suggestCommands(name)
  return {
    error: `no command named "${name}"`,
    cause: "unknown-command",
    fix:
      suggestions.length > 0
        ? [`did you mean: ${suggestions.join(", ")}`]
        : ["cognia-agent api list --search <text>"],
    inspect: ["cognia-agent api list", "cognia-agent api groups"],
  }
}

/** Resolve a host and open a transport, or hand back the failure to print. */
async function openTransport(
  args: ParsedArgs,
  deps: ApiCommandDeps
): Promise<{ transport: HostTransport } | { failure: CliFailure }> {
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const cwd = deps.cwd ?? process.cwd()
  const profile = stringFlag(args, "host") ?? stringFlag(args, "profile")
  const resolution: HostResolution = (deps.resolve ?? resolveHost)({
    ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint") } : {}),
    ...(profile ? { profile } : {}),
    ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
    env,
    home,
    cwd,
  })
  const connected = await (deps.connect ?? connectHost)(resolution, deps.connectDeps ?? {})
  return connected.ok ? { transport: connected.transport } : { failure: connected.failure }
}

function readData(args: ParsedArgs): { value?: unknown } | { failure: CliFailure } {
  const raw = stringFlag(args, "data")
  if (raw === undefined) return {}
  const parsed = parseDataFlag(raw)
  if (parsed.ok) return { value: parsed.value }
  return {
    failure: {
      error: parsed.error,
      ...(parsed.details ? { details: parsed.details } : {}),
      cause: "invalid-request",
      fix: parsed.fix,
    },
  }
}

function failureFix(entry: ApiCommandEntry, code?: string): string[] {
  switch (code) {
    case "interactive_approval_required":
      return [`cognia-agent host lease ${entry.name}`, "then pass --admin-lease <lease>"]
    case "signed_policy_required":
      return ["pass --policy-id <id> naming a policy the host has signed"]
    case "idempotency_key_required":
      return ["pass --idempotency-key <uuid>, or report this as a CLI bug"]
    case "command_transport_forbidden":
      return [`this wire does not carry ${entry.name}`, `cognia-agent api describe ${entry.name}`]
    case "unknown_command":
      return ["this host predates the command", "cognia-agent api list --wire internal"]
    default:
      return ["cognia-agent host show", "re-run with --debug to see the request envelope"]
  }
}

async function runCall(
  args: ParsedArgs,
  options: OutputOptions,
  deps: ApiCommandDeps,
  out: OutputSink
): Promise<number> {
  const name = args.positionals[0]
  if (!name) {
    return usageFailure(out, "api call needs a <command>", [
      "cognia-agent api call plugin_list",
      "cognia-agent api list --search plugin",
    ])
  }
  const entry = findCommand(name)
  if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)

  // Second parse: this command's own boolean fields become boolean flags, so
  // `--muted --id x` cannot read "--id" as the value of "--muted". They are
  // never added to the global set, which would change how other commands parse.
  const booleanFields = entry.flags
    .filter((flag) => flag.type === "boolean" && flag.flag.length > 0)
    .map((flag) => flag.flag)
  const reparsed =
    booleanFields.length > 0 && deps.argv
      ? parseArgv(deps.argv, { booleanFlags: booleanFields })
      : args

  const data = readData(reparsed)
  if ("failure" in data) return emitFailure(out, data.failure, EXIT_USAGE)

  const built = buildRequestBody({
    entry,
    flags: reparsed.flags,
    ...(data.value !== undefined ? { data: data.value } : {}),
  })
  if (!built.ok) {
    return emitFailure(
      out,
      {
        error: built.error,
        ...(built.details ? { details: built.details } : {}),
        cause: "invalid-request",
        fix: built.fix,
      },
      EXIT_USAGE
    )
  }

  const opened = await openTransport(reparsed, deps)
  if ("failure" in opened) return emitFailure(out, opened.failure)

  const refusal = preflight({ entry, transport: opened.transport, body: built.body })
  if (refusal) return emitFailure(out, refusal)

  if (options.debug) {
    out.error(
      `[debug] ${opened.transport.label} ${entry.name} ${JSON.stringify(built.body).slice(0, 2000)}`
    )
  }

  const result = await invokeCommand({
    entry,
    body: built.body,
    transport: opened.transport,
    timeoutMs: options.timeoutMs,
    wait: reparsed.flags.wait === true,
    ...(stringFlag(reparsed, "idempotency-key")
      ? { idempotencyKey: stringFlag(reparsed, "idempotency-key") }
      : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  })

  if (!result.outcome.ok) {
    return emitFailure(out, {
      error: `${entry.name} failed`,
      details: [result.outcome.message],
      cause: result.outcome.cause,
      fix: failureFix(entry, result.outcome.code),
      inspect: [`cognia-agent api describe ${entry.name}`],
      diagnostics: {
        ...(result.outcome.status ? { status: result.outcome.status } : {}),
        ...(result.outcome.code ? { code: result.outcome.code } : {}),
        ...(result.outcome.requestId ? { requestId: result.outcome.requestId } : {}),
        wire: opened.transport.wire,
      },
    })
  }

  if (result.outcome.accepted && !result.waited) {
    out.error(
      `[accepted] ${entry.name} is running as operation ${result.operationId ?? "(no id)"}. Add --wait to follow it.`
    )
  }
  emitResult(out, result.outcome.result, options, entry.name)
  return EXIT_OK
}

async function runRequest(
  args: ParsedArgs,
  options: OutputOptions,
  deps: ApiCommandDeps,
  out: OutputSink
): Promise<number> {
  const [method, routePath] = args.positionals
  if (!method || !routePath) {
    return usageFailure(out, "api request needs <METHOD> and <path>", [
      "cognia-agent api request GET /api/devices",
    ])
  }
  if (!routePath.startsWith("/")) {
    return usageFailure(out, `path must start with "/", got "${routePath}"`, [
      "cognia-agent api request GET /api/devices",
    ])
  }
  const data = readData(args)
  if ("failure" in data) return emitFailure(out, data.failure, EXIT_USAGE)

  const opened = await openTransport(args, deps)
  if ("failure" in opened) return emitFailure(out, opened.failure)

  if (options.debug) out.error(`[debug] ${opened.transport.label} ${method} ${routePath}`)

  const outcome = await opened.transport.request(method, routePath, data.value, {
    timeoutMs: options.timeoutMs,
  })
  if (!outcome.ok) {
    return emitFailure(out, {
      error: `${method.toUpperCase()} ${routePath} failed`,
      details: [outcome.message],
      cause: outcome.cause,
      fix: ["cognia-agent host show", "check the route against protocol/companion-api-routes.json"],
      diagnostics: {
        ...(outcome.status ? { status: outcome.status } : {}),
        ...(outcome.code ? { code: outcome.code } : {}),
        wire: opened.transport.wire,
      },
    })
  }
  const basename = routePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
  emitResult(out, outcome.result, options, basename.length > 0 ? basename : "request")
  return EXIT_OK
}

export async function apiCommand(args: ParsedArgs, deps: ApiCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput

  if (args.help || !args.subcommand) {
    out.write(API_HELP)
    return args.subcommand ? EXIT_OK : EXIT_USAGE
  }

  const options = resolveOutputOptions(args, deps.env ?? process.env)
  if ("error" in options) return usageFailure(out, options.error, [options.fix])

  switch (args.subcommand) {
    case "list": {
      const rows = listCommands({
        ...(stringFlag(args, "group") ? { group: stringFlag(args, "group") } : {}),
        ...(stringFlag(args, "wire")
          ? { wire: stringFlag(args, "wire") as "internal" | "http" }
          : {}),
        ...(stringFlag(args, "capability") ? { capability: stringFlag(args, "capability") } : {}),
        ...(stringFlag(args, "risk")
          ? { risk: stringFlag(args, "risk") as "low" | "high" | "critical" }
          : {}),
        ...(stringFlag(args, "approval")
          ? { approval: stringFlag(args, "approval") as "none" | "interactive" | "signed-policy" }
          : {}),
        ...(stringFlag(args, "search") ? { search: stringFlag(args, "search") } : {}),
      }).map(projectRow)
      emitResult(out, rows, options, "api-list")
      return EXIT_OK
    }
    case "groups": {
      const wire = stringFlag(args, "wire") as "internal" | "http" | undefined
      emitResult(out, commandGroups(wire), options, "api-groups")
      return EXIT_OK
    }
    case "describe": {
      const name = args.positionals[0]
      if (!name) {
        return usageFailure(out, "api describe needs a <command>", [
          "cognia-agent api describe plugin_list",
        ])
      }
      const entry = findCommand(name)
      if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)
      emitResult(out, describeEntry(entry), options, `${entry.name}-describe`)
      return EXIT_OK
    }
    case "schema": {
      const name = args.positionals[0]
      if (!name) {
        return usageFailure(out, "api schema needs a <command>", [
          "cognia-agent api schema adapter_update_policy --template",
        ])
      }
      const entry = findCommand(name)
      if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)
      if (args.flags.template === true) {
        // A template is meant to be piped into an editor and back through
        // --data, so it is always JSON regardless of --format.
        emitResult(
          out,
          requestTemplate(entry),
          { ...options, format: "json" },
          `${entry.name}-body`
        )
        return EXIT_OK
      }
      emitResult(out, describeEntry(entry).fields, options, `${entry.name}-schema`)
      return EXIT_OK
    }
    case "call":
      return runCall(args, options, deps, out)
    case "request":
      return runRequest(args, options, deps, out)
    default:
      return usageFailure(
        out,
        `unknown api subcommand "${args.subcommand}"`,
        ["cognia-agent api --help"],
        ["cognia-agent api list"]
      )
  }
}
