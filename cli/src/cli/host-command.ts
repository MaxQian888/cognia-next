/**
 * `cognia-agent host ...`, the saved hosts the API plane talks to.
 *
 * A host is an endpoint plus the credential that proves who is calling. Two
 * kinds exist because the Host admits exactly two authority modes: a loopback
 * service token on the headless wire, and a DPoP device session on the paired
 * wire. `host login` is what turns this machine into a device the owner can
 * see, grant and revoke in the Device Console.
 *
 * `host show` prints where every value came from, because the first question
 * after an unexpected 401 is always "which token did it just use".
 */

import os from "node:os"

import { stringFlag, type ParsedArgs } from "./args"
import { EXIT_OK, EXIT_USAGE, emitFailure, usageFailure } from "./errors"
import { emitResult, resolveOutputOptions } from "./format"
import { realOutput, type OutputSink } from "./output"
import { resolveHome } from "../config/load"
import { loginHost } from "../host/login"
import { describeResolution, resolveHost } from "../host/resolve"
import {
  addHost,
  hostsPath,
  projectHostsPath,
  readHostsFile,
  redactHost,
  removeHost,
  activateHost,
  writeHostsFile,
  type HostKind,
  type HostRecord,
  type HostsFs,
} from "../host/store"

export const HOST_HELP = `cognia-agent host - the Cognia hosts this CLI can call

Usage:
  cognia-agent host add <name> --endpoint <url> [--kind headless|device]
                              [--tenant <id>] [--token <service token>]
                              [--fingerprint <sha256 hex>] [--use]
  cognia-agent host list
  cognia-agent host login <name> --endpoint <url> --pair-code <code>
                              [--fingerprint <sha256 hex>] [--tenant <id>]
                              [--label <display name>]
  cognia-agent host use <name>
  cognia-agent host show                 the active host, with the source of each value
  cognia-agent host remove <name>
  cognia-agent host path                 where the hosts file lives

Flags:
  --local        write to ./.cognia/hosts.json instead of the CLI home
  --format raw|json|pretty
  -o, --output <dir>

Kinds:
  headless  POST /internal/_rpc, loopback service token, carries every command
  device    POST /api/_rpc, DPoP device session, execution and host-admin only

Secrets live in hosts.json at 0600. They are never printed back, only shown
as "(set)".
`

export interface HostCommandDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  fs?: HostsFs
  /** Injected so `host login` unit-tests without a real host to pair with. */
  login?: Partial<Parameters<typeof loginHost>[0]>
}

function targetPath(args: ParsedArgs, home: string, cwd: string): string {
  return args.flags.local === true ? projectHostsPath(cwd) : hostsPath(home)
}

export async function hostCommand(args: ParsedArgs, deps: HostCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const cwd = deps.cwd ?? process.cwd()

  if (args.help || !args.subcommand) {
    out.write(HOST_HELP)
    return args.subcommand ? EXIT_OK : EXIT_USAGE
  }

  const options = resolveOutputOptions(args, env)
  if ("error" in options) return usageFailure(out, options.error, [options.fix])

  const file = targetPath(args, home, cwd)

  switch (args.subcommand) {
    case "path": {
      emitResult(
        out,
        { user: hostsPath(home), project: projectHostsPath(cwd), writing: file },
        options,
        "host-path"
      )
      return EXIT_OK
    }
    case "add": {
      const name = args.positionals[0]
      const endpoint = stringFlag(args, "endpoint")
      if (!name || !endpoint) {
        return usageFailure(out, "host add needs a <name> and --endpoint", [
          "cognia-agent host add local --endpoint https://127.0.0.1:27890",
        ])
      }
      const kind = (stringFlag(args, "kind") ?? "headless") as HostKind
      if (kind !== "headless" && kind !== "device") {
        return usageFailure(out, `unknown --kind "${kind}"`, ["use headless or device"])
      }
      const record: HostRecord = {
        kind,
        endpoint,
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        ...(stringFlag(args, "token") ? { serviceToken: stringFlag(args, "token") } : {}),
        ...(stringFlag(args, "fingerprint")
          ? { serverFingerprint: stringFlag(args, "fingerprint") }
          : {}),
        ...(stringFlag(args, "label") ? { label: stringFlag(args, "label") } : {}),
      }
      const updated = addHost(readHostsFile(file, deps.fs), name, record, {
        activate: args.flags.use === true,
      })
      writeHostsFile(file, updated, deps.fs)
      emitResult(
        out,
        { added: name, active: updated.active, file, ...redactHost(updated.hosts[name]) },
        options,
        "host-add"
      )
      return EXIT_OK
    }
    case "login": {
      const name = args.positionals[0]
      const endpoint = stringFlag(args, "endpoint")
      const invitation = stringFlag(args, "pair-code") ?? stringFlag(args, "invitation")
      if (!name || !endpoint || !invitation) {
        return usageFailure(
          out,
          "host login needs a <name>, --endpoint and --pair-code",
          ["cognia-agent host login desktop --endpoint https://127.0.0.1:27890 --pair-code ABC123"],
          ["take a pairing code from Settings then Companion on the host"]
        )
      }
      const result = await loginHost({
        endpoint,
        invitation,
        ...(stringFlag(args, "label") ? { displayName: stringFlag(args, "label") } : {}),
        ...(stringFlag(args, "fingerprint")
          ? { serverFingerprint: stringFlag(args, "fingerprint") }
          : {}),
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        ...(deps.login ?? {}),
      })
      if (!result.ok) return emitFailure(out, result.failure)
      const updated = addHost(readHostsFile(file, deps.fs), name, result.record, {
        activate: args.flags.use === true,
      })
      writeHostsFile(file, updated, deps.fs)
      emitResult(
        out,
        { paired: name, active: updated.active, file, ...redactHost(result.record) },
        options,
        "host-login"
      )
      return EXIT_OK
    }
    case "list": {
      const stored = readHostsFile(file, deps.fs)
      const rows = Object.entries(stored.hosts).map(([name, record]) => ({
        name,
        active: stored.active === name ? "yes" : "",
        ...redactHost(record),
      }))
      emitResult(out, rows, options, "host-list")
      return EXIT_OK
    }
    case "use": {
      const name = args.positionals[0]
      if (!name) return usageFailure(out, "host use needs a <name>", ["cognia-agent host list"])
      const result = activateHost(readHostsFile(file, deps.fs), name)
      if (result.error) {
        return emitFailure(
          out,
          {
            error: result.error,
            cause: "invalid-request",
            fix: ["cognia-agent host add " + name + " --endpoint <url>"],
            inspect: ["cognia-agent host list"],
          },
          EXIT_USAGE
        )
      }
      writeHostsFile(file, result.file, deps.fs)
      emitResult(out, { active: name, file }, options, "host-use")
      return EXIT_OK
    }
    case "remove": {
      const name = args.positionals[0]
      if (!name) return usageFailure(out, "host remove needs a <name>", ["cognia-agent host list"])
      const result = removeHost(readHostsFile(file, deps.fs), name)
      if (result.error) {
        return emitFailure(
          out,
          { error: result.error, cause: "invalid-request", fix: ["cognia-agent host list"] },
          EXIT_USAGE
        )
      }
      writeHostsFile(file, result.file, deps.fs)
      emitResult(
        out,
        { removed: name, active: result.file.active ?? null, file },
        options,
        "host-remove"
      )
      return EXIT_OK
    }
    case "show": {
      const profile = stringFlag(args, "host") ?? stringFlag(args, "profile")
      const resolution = resolveHost({
        ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint") } : {}),
        ...(profile ? { profile } : {}),
        ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
        env,
        home,
        cwd,
        ...(deps.fs ? { fs: deps.fs } : {}),
      })
      if (!resolution.host) {
        return emitFailure(out, {
          error: "no Cognia host resolves here",
          details: resolution.skipped.map((leg) => `${leg.leg}: ${leg.reason}`),
          cause: "no-host",
          fix: [
            "cognia-agent host add local --endpoint https://127.0.0.1:27890",
            "or export COGNIA_SERVER_URL and COGNIA_SERVICE_TOKEN",
          ],
          inspect: ["cognia-agent host path"],
        })
      }
      emitResult(out, describeResolution(resolution.host), options, "host-show")
      return EXIT_OK
    }
    default:
      return usageFailure(
        out,
        `unknown host subcommand "${args.subcommand}"`,
        ["cognia-agent host --help"],
        ["cognia-agent host list"]
      )
  }
}
