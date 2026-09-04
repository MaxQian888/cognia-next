"use client"

/**
 * CLI updates for `@cognia/agent-cli`.
 *
 * Cognia never rewrites a globally installed CLI itself. It detects which
 * package manager owns the install and hands the user the exact command, which
 * is why the executor is `package-manager` and the action is
 * `run-package-manager` rather than `install-in-app`.
 */

import type { UpdateCandidate } from "@cognia/agent-config-types"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { bestCandidate } from "../catalog-lookup"

export const CLI_ASSET_ID = "@cognia/agent-cli"

export type CliPackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown"

/** Upgrade command for one package manager. */
export function cliUpgradeCommand(manager: CliPackageManager, version?: string): string {
  const spec = version ? `${CLI_ASSET_ID}@${version}` : `${CLI_ASSET_ID}@latest`
  switch (manager) {
    case "npm":
      return `npm install -g ${spec}`
    case "pnpm":
      return `pnpm add -g ${spec}`
    case "yarn":
      return `yarn global add ${spec}`
    case "bun":
      return `bun add -g ${spec}`
    default:
      return `npm install -g ${spec}`
  }
}

/** Every command a user could plausibly need when the source is ambiguous. */
export function cliUpgradeCommandChoices(version?: string): string[] {
  return (["npm", "pnpm", "yarn", "bun"] as const).map((m) => cliUpgradeCommand(m, version))
}

export interface CliAdapterDeps {
  /** Version of the CLI installed on this machine, or null when absent. */
  installedVersion?: () => Promise<string | null>
  packageManager?: () => Promise<CliPackageManager>
  isSupported?: () => boolean
}

export function createCliAdapter(deps: CliAdapterDeps = {}): UpdateAdapter {
  return {
    kind: "cli",
    executor: "package-manager",
    isSupported: () => deps.isSupported?.() ?? Boolean(deps.installedVersion),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const current = (await deps.installedVersion?.()) ?? null
      // Nothing installed is not an update. Offering one would be an install
      // pitch dressed as maintenance.
      if (!current) return []
      const candidate = bestCandidate(context.catalog, {
        kind: "cli",
        assetId: CLI_ASSET_ID,
        executor: "package-manager",
        currentVersion: current,
        channel: context.channel,
      })
      return candidate ? [candidate] : []
    },

    async apply(
      candidate: UpdateCandidate,
      _context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      const manager = (await deps.packageManager?.()) ?? "unknown"
      const command = cliUpgradeCommand(manager, candidate.targetVersion)
      // Handing back the command is the whole action. Running a global install
      // on the user's behalf would need elevation we will not silently request.
      return { state: "awaiting-store", command }
    },
  }
}
