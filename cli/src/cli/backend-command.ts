import path from "node:path"
import { fileURLToPath } from "node:url"

import type { ParsedArgs } from "./args"
import {
  DshInstallError,
  defaultDataRoot,
  doctorInstalledDshRuntime,
  installDshRuntime,
  removeDshRuntime,
  runtimeHomeFor,
} from "../runtime/external/dsh-installer"
import type { DshProfileId } from "@/types/agent/dsh-runtime-channel"

/**
 * `cognia-agent backend <install|doctor|remove> <backend>` — manage runtimes
 * Cognia owns rather than discovers on PATH.
 *
 * Only `deepseek-harness` exists today. Every other external agent is an
 * existing CLI the user installs themselves; DeepSeek Harness publishes no
 * executable for the transports Cognia drives, so Cognia has to install and
 * certify a runtime home of its own.
 */

export interface BackendCommandContext {
  out: { write: (text: string) => void; error: (text: string) => void }
  /**
   * Overridable installer, so tests exercise this command surface without
   * spawning a real `npm install`.
   */
  install?: typeof installDshRuntime
}

const SUPPORTED_BACKENDS = new Set(["deepseek-harness"])

/**
 * Locate `runtime/deepseek-harness/` relative to the built CLI.
 *
 * Resolved from this module's own URL so it works from a global install as well
 * as from the repo, where the compiled CLI sits under `cli/dist/`.
 */
export function resolveRuntimeSourceDir(moduleUrl: string): string {
  const here = path.dirname(fileURLToPath(moduleUrl))
  // cli/dist/cli/ -> repo root, or cli/src/cli/ -> repo root.
  return path.resolve(here, "..", "..", "..", "runtime", "deepseek-harness")
}

function parseProfile(args: ParsedArgs): DshProfileId {
  const raw = typeof args.flags?.profile === "string" ? args.flags.profile : undefined
  if (raw === "workspace") return "cognia-sdk-workspace"
  // Read-only is the default because it is the only profile whose authority
  // cannot be escalated at runtime on this transport.
  return "cognia-sdk-readonly"
}

export async function backendCommand(
  args: ParsedArgs,
  ctx: BackendCommandContext
): Promise<number> {
  // `backend` is a grouped command, so the action lands in `subcommand`.
  const action = args.subcommand
  const backend = args.positionals[0]

  if (!action) {
    ctx.out.error("usage: cognia-agent backend <install|doctor|remove> <backend>")
    return 1
  }
  if (!backend) {
    ctx.out.error(`usage: cognia-agent backend ${action} <backend>`)
    return 1
  }
  if (!SUPPORTED_BACKENDS.has(backend)) {
    ctx.out.error(
      `unknown backend ${backend}; supported: ${[...SUPPORTED_BACKENDS].sort().join(", ")}`
    )
    return 1
  }

  const dataRoot = defaultDataRoot()
  const profileId = parseProfile(args)

  try {
    switch (action) {
      case "install": {
        const channel = await (ctx.install ?? installDshRuntime)({
          dataRoot,
          sourceDir: resolveRuntimeSourceDir(import.meta.url),
          onProgress: (line) => ctx.out.write(`${line}\n`),
        })
        ctx.out.write(`Installed to ${runtimeHomeFor(dataRoot)}\n`)
        ctx.out.write(`Channel: ${channel.channelId} (upstream ${channel.upstreamVersion})\n`)
        // Upstream is a developer preview that promises breaking changes, so
        // this is not a footnote.
        ctx.out.write("This runtime is EXPERIMENTAL: upstream may break compatibility.\n")
        return 0
      }
      case "doctor": {
        const report = doctorInstalledDshRuntime({ dataRoot, profileId })
        if (report.healthy) {
          ctx.out.write(`${backend}: healthy (${profileId})\n`)
          return 0
        }
        ctx.out.error(`${backend}: unhealthy (${profileId})`)
        for (const finding of report.findings) {
          ctx.out.error(`  [${finding.severity}] ${finding.code}: ${finding.detail}`)
        }
        return 1
      }
      case "remove": {
        removeDshRuntime({ dataRoot })
        ctx.out.write(`Removed ${runtimeHomeFor(dataRoot)}\n`)
        return 0
      }
      default:
        ctx.out.error(`unknown action ${action}; expected install, doctor, or remove`)
        return 1
    }
  } catch (error) {
    if (error instanceof DshInstallError) {
      ctx.out.error(error.message)
      return 1
    }
    throw error
  }
}
