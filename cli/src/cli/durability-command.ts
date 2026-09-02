/**
 * `cognia-agent durability …` — headless recovery tooling for ADR-0059's
 * durability ladder.
 *
 * Five verbs, all account-scoped:
 *
 * ```
 * durability verify   --account <id>
 * durability migrate  --account <id> --to journal|sqlite
 * durability recover  --account <id> --from auto|snapshot|journal|sqlite [--activate]
 * durability rollback --account <id> --to <generation>
 * durability finalize --account <id> --generation <id> --confirm
 * ```
 *
 * The tooling never runs the brain: it operates on files while `serve` is
 * stopped. Every verb prints a human summary by default and a machine record
 * under `--json`, because these are the commands an operator reaches for during
 * an incident and both audiences are real.
 */
import os from "node:os"

import { resolveHome } from "../config/load"
import { durabilityRoot } from "../serve/persistence/backend"
import {
  finalizeDurability,
  migrateDurability,
  parseBackendArgument,
  recoverDurability,
  rollbackDurability,
  verifyDurability,
  type RecoverySource,
} from "../serve/persistence/operations"
import { formatParityReport } from "../serve/persistence/parity"
import { DurabilityFault, type DurabilityBackendId } from "../serve/persistence/types"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import type { OutputSink } from "./output"

export const DURABILITY_HELP = `cognia-agent durability — headless persistence tooling

  durability verify   --account <id>                         report backends, generations, faults
  durability migrate  --account <id> --to journal|sqlite     parity-gated backend switch
  durability recover  --account <id> --from auto|snapshot|journal|sqlite [--activate]
  durability rollback --account <id> --to <generation>       re-point at an existing generation
  durability finalize --account <id> --generation <id> --confirm

Flags:
  --home <dir>   durability root parent (default: COGNIA_HOME or ~/.cognia)
  --json         emit one machine-readable record instead of the summary
`

export interface DurabilityDeps {
  out: OutputSink
  env?: Record<string, string | undefined>
  now?: () => number
  /**
   * Migration seam. Production always uses {@link migrateDurability}; tests
   * substitute it to drive the refuse-to-promote reporting path, which cannot
   * be reached from the outside without corrupting a backend on purpose.
   */
  migrate?: typeof migrateDurability
}

const RECOVERY_SOURCES: RecoverySource[] = ["auto", "snapshot", "journal", "sqlite"]

export async function durabilityCommand(args: ParsedArgs, deps: DurabilityDeps): Promise<number> {
  const { out } = deps
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const json = boolFlag(args, "json")
  const verb = args.positionals[0] ?? args.subcommand

  if (!verb || verb === "help") {
    out.write(DURABILITY_HELP)
    return verb ? 0 : 2
  }

  const accountId = stringFlag(args, "account")
  if (!accountId) {
    out.error("durability: --account <id> is required\n")
    return 2
  }
  const home = stringFlag(args, "home") ?? resolveHome(env, os.homedir())
  const root = durabilityRoot(home, accountId)

  try {
    switch (verb) {
      case "verify":
        return await runVerify(root, out, json)
      case "migrate":
        return await runMigrate(
          root,
          parseBackendArgument(stringFlag(args, "to")),
          out,
          json,
          now,
          deps.migrate ?? migrateDurability
        )
      case "recover":
        return await runRecover(root, args, out, json, now)
      case "rollback":
        return runRollback(root, stringFlag(args, "to"), out, json, now)
      case "finalize":
        return runFinalize(root, args, out, json, now)
      default:
        out.error(`durability: unknown subcommand "${verb}"\n`)
        out.write(DURABILITY_HELP)
        return 2
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof DurabilityFault ? error.code : "error"
    if (json) out.json({ ok: false, code, message })
    else out.error(`durability: ${message}\n`)
    return 1
  }
}

async function runVerify(root: string, out: OutputSink, json: boolean): Promise<number> {
  const status = await verifyDurability(root)
  if (json) {
    out.json({ ok: status.faults.length === 0, ...status })
    return status.faults.length === 0 ? 0 : 1
  }
  out.write(`root:            ${status.root}\n`)
  out.write(`active backend:  ${status.manifest.activeBackend}\n`)
  out.write(`shadow backend:  ${status.manifest.shadowBackend ?? "-"}\n`)
  out.write(`generations:     ${status.generations.join(", ") || "-"}\n`)
  out.write(`checkpoint seq:  ${status.checkpointSequence ?? "-"}\n`)
  out.write(
    `journal commits: ${status.journalCommits} (sequence ${status.journalSequence ?? "-"})\n`
  )
  if (status.journalDiscardedBytes > 0) {
    out.write(`journal tail:    discarded ${status.journalDiscardedBytes} torn bytes\n`)
  }
  out.write(
    `sqlite:          ${status.sqlitePresent ? `present (sequence ${status.sqliteSequence ?? "-"})` : "absent"}\n`
  )
  out.write(`rollback mark:   ${status.manifest.rollbackWatermark ?? "-"}\n`)
  if (status.parity) out.write(`${formatParityReport(status.parity)}\n`)
  for (const fault of status.faults) {
    out.error(
      `fault ${fault.code}${fault.sequence === null ? "" : ` @${fault.sequence}`}: ${fault.message}\n`
    )
  }
  return status.faults.length === 0 ? 0 : 1
}

async function runMigrate(
  root: string,
  to: DurabilityBackendId,
  out: OutputSink,
  json: boolean,
  now: () => number,
  migrate: typeof migrateDurability
): Promise<number> {
  const result = await migrate(root, to, { now })
  if (json) {
    out.json({ ok: result.promoted, ...result })
    return result.promoted ? 0 : 1
  }
  out.write(
    `rollback bundle: ${result.bundle.id} (generation ${result.bundle.generation ?? "-"})\n`
  )
  out.write(`${formatParityReport(result.parity)}\n`)
  if (!result.promoted) {
    out.error(`durability: parity failed — ${result.from} remains active\n`)
    return 1
  }
  out.write(`active backend:  ${result.to} (shadow ${result.from})\n`)
  return 0
}

async function runRecover(
  root: string,
  args: ParsedArgs,
  out: OutputSink,
  json: boolean,
  now: () => number
): Promise<number> {
  const raw = stringFlag(args, "from") ?? "auto"
  if (!RECOVERY_SOURCES.includes(raw as RecoverySource)) {
    out.error(`durability: --from must be one of ${RECOVERY_SOURCES.join(", ")}\n`)
    return 2
  }
  const result = await recoverDurability(root, raw as RecoverySource, {
    activate: boolFlag(args, "activate"),
    now,
  })
  if (json) {
    out.json({ ok: true, ...result })
    return 0
  }
  out.write(`recovered from:  ${result.source}\n`)
  out.write(`staged as:       ${result.generation} (sequence ${result.sequence})\n`)
  out.write(`activated:       ${result.activated ? "yes" : "no (pass --activate)"}\n`)
  return 0
}

function runRollback(
  root: string,
  generation: string | undefined,
  out: OutputSink,
  json: boolean,
  now: () => number
): number {
  if (!generation) {
    out.error("durability: rollback requires --to <generation>\n")
    return 2
  }
  const result = rollbackDurability(root, generation, now)
  if (json) {
    out.json({ ok: true, ...result })
    return 0
  }
  out.write(`rolled back to:  ${generation} (re-cut as ${result.generation})\n`)
  out.write(`sequence:        ${result.sequence}\n`)
  return 0
}

function runFinalize(
  root: string,
  args: ParsedArgs,
  out: OutputSink,
  json: boolean,
  now: () => number
): number {
  const generation = stringFlag(args, "generation")
  if (!generation) {
    out.error("durability: finalize requires --generation <id>\n")
    return 2
  }
  const result = finalizeDurability(root, generation, {
    confirm: boolFlag(args, "confirm"),
    now,
  })
  if (json) {
    out.json({ ok: true, ...result })
    return 0
  }
  out.write(`pruned:          ${result.prunedGenerations.join(", ") || "-"}\n`)
  out.write(`kept:            ${result.keptGenerations.join(", ")}\n`)
  out.write(`rollback mark:   ${result.rollbackWatermark}\n`)
  return 0
}
