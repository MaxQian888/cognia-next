/**
 * `cognia-agent provider …` (ADR-0163 Phase 6): the provider operation plane
 * from the terminal.
 *
 * ```
 * provider capabilities [--provider id] [--operation id]
 * provider models       [--provider id] [--refresh]
 * provider balance      --live [--provider id]
 * provider limits       --live [--provider id]
 * provider usage        [--provider id] [--days n]
 * provider probe        --live --yes [--provider id] [--model m]
 * ```
 *
 * Answers come from the first plane that is up (desktop bridge, then
 * `cognia-server`, then this process), and a verb an older host does not
 * carry degrades to the local path for that verb only. Reads that bill the
 * account (`balance`, `limits`, `probe`) require an explicit `--live`, and a
 * probe additionally `--yes` because it spends tokens on every provider.
 *
 * No management credential ever leaves this process. The dev token and the
 * service token are sent only to the plane that issued them.
 */

import os from "node:os"

import { PROVIDER_OPERATION_IDS, isProviderOperationId } from "@cognia/provider-types"

import { loadConfig as defaultLoadConfig, resolveHome } from "../config/load"
import type { ResolvedConfig } from "../config/schema"
import { formatCapabilityCell, readProviderCapabilities } from "../provider/capabilities"
import { readProviderLimits, formatMeterLine, type LimitsVerb } from "../provider/limits"
import { createCliProviderExecutor, type CliProviderExecutor } from "../provider/local"
import { formatModelLine, listProviderModels } from "../provider/models"
import { formatGatewayProbeRow, formatLocalProbeRow, probeProviders } from "../provider/probe"
import {
  PROVIDER_TRANSPORT_PREFERENCES,
  resolveProviderTransport,
  type ProviderTransportPreference,
  type ProviderTransportResolution,
} from "../provider/transport"
import { formatUsageRow, readProviderUsage, type ReadUsageDeps } from "../provider/usage"
import {
  applyFilters,
  formatSourceDiagnostic,
  parseScope,
  USAGE_CLI_SCOPES,
  type SourceDiagnostic,
} from "../provider/usage-filters"
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export const PROVIDER_VERBS = [
  "capabilities",
  "models",
  "balance",
  "limits",
  "usage",
  "probe",
] as const
export type ProviderVerb = (typeof PROVIDER_VERBS)[number]

export const PROVIDER_HELP = `cognia-agent provider — the provider operation plane from the terminal

  provider capabilities [--provider id] [--operation id]   operation profile per provider
  provider models       [--provider id] [--refresh]        model inventory (catalog + upstream)
  provider balance      --live [--provider id]             credit balance meters
  provider limits       --live [--provider id]             usage window meters
  provider usage        [--provider id] [--days n] [--scope s] [--source id] [--model m]
                                                            local spend per provider and model
  provider probe        --live --yes [--provider id] [--model m]
                                                            one minimal request per provider

Flags:
  --provider <id>       one configured provider (default: every configured one)
  --operation <id>      capabilities: only this operation's cell
  --refresh             models: bypass the cached inventory and ask upstream
  --days <n>            usage: window length (default 7)
  --scope <s>           usage: cognia (default) | all-tools. all-tools folds in
                        what your other coding agents cost, shown separately
  --source <id>         usage: restrict all-tools to one external agent
  --model <id>          usage: substring match on the model id
                        probe: the model to route (gateway probe needs it)
  --transport <t>       auto (default) | bridge | rpc | local
  --live                required for balance, limits and probe: these read the
                        account upstream and may be billed
  --yes                 required for probe: it spends tokens on every provider
  --json                emit one machine-readable record instead of the summary

Answers come from the running Cognia desktop (CLI bridge) when there is one,
else a configured cognia-server, else this process. A verb the attached host
does not carry falls back to the local path for that verb only.
`

export interface ProviderCommandDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  now?: () => number
  loadConfig?: (flags?: Record<string, string | boolean>) => ResolvedConfig
  resolveTransport?: (prefer: ProviderTransportPreference) => Promise<ProviderTransportResolution>
  createExecutor?: (config: ResolvedConfig) => CliProviderExecutor
  /** Seams the verb modules expose (tests). */
  loadLimits?: LimitsLoader
  ensureDb?: ReadUsageDeps["ensureDb"]
  fsx?: ReadUsageDeps["fsx"]
  modelCatalog?: ReadUsageDeps["modelCatalog"]
  /**
   * External-agent scan diagnostics for `provider usage`.
   *
   * Injected rather than imported, because the CLI must not drag the whole
   * session-import registry into every invocation just to print a summary the
   * common case does not ask for. Absent means the section is omitted, which
   * is the correct rendering for a host that never scanned anything.
   */
  usageSources?: () => Promise<SourceDiagnostic[]>
}

type LimitsLoader = NonNullable<Parameters<typeof readProviderLimits>[0]["loadLimits"]>

const BILLED_VERBS = new Set<ProviderVerb>(["balance", "limits", "probe"])

function isVerb(value: string | undefined): value is ProviderVerb {
  return (PROVIDER_VERBS as readonly string[]).includes(value ?? "")
}

function transportPreference(args: ParsedArgs): ProviderTransportPreference | null {
  const raw = stringFlag(args, "transport") ?? "auto"
  return (PROVIDER_TRANSPORT_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as ProviderTransportPreference)
    : null
}

function transportHeader(resolution: ProviderTransportResolution): string {
  const lines = [`Transport: ${resolution.transport.label}`]
  for (const skipped of resolution.skipped)
    lines.push(`  skipped ${skipped.kind}: ${skipped.message}`)
  return lines.join("\n")
}

export async function providerCommand(
  args: ParsedArgs,
  deps: ProviderCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const json = boolFlag(args, "json")
  const verb = args.subcommand ?? args.positionals[0]

  if (args.help) {
    out.write(PROVIDER_HELP)
    return 0
  }
  if (!verb) {
    out.error(PROVIDER_HELP)
    return 2
  }
  if (!isVerb(verb)) {
    out.error(`Unknown provider verb: "${verb}"\n\n${PROVIDER_HELP}`)
    return 2
  }

  if (BILLED_VERBS.has(verb) && !boolFlag(args, "live")) {
    out.error(
      `provider ${verb} reads the account upstream and may be billed. Re-run with --live to confirm.\n`
    )
    return 2
  }
  if (verb === "probe" && !boolFlag(args, "yes")) {
    out.error(`provider probe sends one real request per provider. Add --yes to spend it.\n`)
    return 2
  }

  const prefer = transportPreference(args)
  if (!prefer) {
    out.error(`--transport must be one of ${PROVIDER_TRANSPORT_PREFERENCES.join(", ")}\n`)
    return 2
  }

  const operationId = stringFlag(args, "operation")
  if (operationId !== undefined && !isProviderOperationId(operationId)) {
    out.error(
      `Unknown operation "${operationId}". Known operations:\n  ${PROVIDER_OPERATION_IDS.join("\n  ")}\n`
    )
    return 2
  }

  let config: ResolvedConfig
  try {
    config = (deps.loadConfig ?? defaultLoadConfig)()
  } catch (error) {
    out.error(`Config error: ${(error as Error).message}\n`)
    return 2
  }

  const providerId = stringFlag(args, "provider")
  if (providerId && !config.providers?.[providerId] && providerId !== config.provider) {
    out.error(
      `Provider "${providerId}" is not configured. Add it under providers in ~/.cognia/config.json.\n`
    )
    return 2
  }

  const resolution = await (
    deps.resolveTransport ?? ((p) => resolveProviderTransport({ prefer: p }))
  )(prefer)
  const transport = resolution.transport
  const executor = (deps.createExecutor ?? ((c) => createCliProviderExecutor(c)))(config)
  const now = deps.now ?? Date.now

  switch (verb) {
    case "capabilities": {
      const report = await readProviderCapabilities({
        config,
        executor,
        transport,
        ...(providerId ? { providerId } : {}),
        ...(operationId ? { operationId } : {}),
      })
      if (json) {
        out.json({ verb, skipped: resolution.skipped, ...report })
        return report.providers.some((p) => p.failure) ? 1 : 0
      }
      out.write(`${transportHeader(resolution)}\n`)
      out.write(
        `Contract v${report.schemaVersion}: ${report.operationCount} operations` +
          (report.adminCommands.length
            ? `, desktop admin commands: ${report.adminCommands.join(", ")}`
            : "") +
          "\n"
      )
      let failed = false
      for (const entry of report.providers) {
        out.write(`\n${entry.providerId}\n`)
        if (entry.failure) {
          failed = true
          out.write(`  ${entry.failure.availability}: ${entry.failure.failure.message}\n`)
          continue
        }
        for (const cell of entry.profile!.cells) out.write(`  ${formatCapabilityCell(cell)}\n`)
        if (entry.profile!.cells.length === 0) out.write(`  (no matching operation)\n`)
      }
      return failed ? 1 : 0
    }

    case "models": {
      const report = await listProviderModels({
        config,
        executor,
        ...(providerId ? { providerId } : {}),
        refresh: boolFlag(args, "refresh"),
      })
      if (json) {
        out.json({ verb, transport: transport.kind, ...report })
        return report.failure ? 1 : 0
      }
      out.write(`${transportHeader(resolution)}\n`)
      if (report.failure) {
        out.error(
          `${report.providerId}: ${report.failure.availability}: ${report.failure.failure.message}\n`
        )
        return 1
      }
      const listing = report.listing!
      out.write(
        `${report.providerId}: ${listing.models.length} models (${listing.source}, ${listing.freshness}, fetched ${new Date(listing.fetchedAt).toISOString()})\n`
      )
      for (const model of listing.models) out.write(`  ${formatModelLine(model)}\n`)
      return 0
    }

    case "balance":
    case "limits": {
      const report = await readProviderLimits({
        config,
        verb: verb as LimitsVerb,
        ...(providerId ? { providerId } : {}),
        now,
        ...(deps.loadLimits ? { loadLimits: deps.loadLimits } : {}),
      })
      if (json) {
        out.json({ transport: transport.kind, ...report })
        return report.snapshots.some((s) => s.error) ? 1 : 0
      }
      out.write(`${transportHeader(resolution)}\n`)
      let failed = false
      for (const snapshot of report.snapshots) {
        out.write(`\n${snapshot.accountLabel ?? snapshot.accountId ?? snapshot.provider}\n`)
        if (snapshot.error) {
          failed = true
          out.write(`  error: ${snapshot.error}\n`)
        }
        for (const meter of snapshot.meters) {
          out.write(`  ${formatMeterLine(meter, report.fetchedAt)}\n`)
        }
      }
      if (report.silent.length > 0) {
        out.write(
          `\nNo ${verb === "balance" ? "balance" : "window"} meters: ${report.silent.join(", ")}\n`
        )
      }
      if (report.snapshots.length === 0 && report.silent.length === 0) {
        out.write(`No configured provider exposes ${verb} meters.\n`)
      }
      return failed ? 1 : 0
    }

    case "usage": {
      const days = numberFlag(args, "days") ?? 7
      if (!Number.isFinite(days) || days <= 0) {
        out.error(`--days must be a positive number\n`)
        return 2
      }
      const scope = parseScope(stringFlag(args, "scope"))
      if (!scope) {
        out.error(`--scope must be one of: ${USAGE_CLI_SCOPES.join(", ")}\n`)
        return 2
      }
      const sourceFilter = stringFlag(args, "source")
      if (sourceFilter && scope !== "all-tools") {
        // Naming a source while scoped to this app would silently return
        // nothing, which reads as "that agent has no spend" rather than
        // "you asked the wrong scope".
        out.error(`--source requires --scope all-tools\n`)
        return 2
      }
      const filters = {
        scope,
        ...(sourceFilter ? { sourceId: sourceFilter } : {}),
        ...(stringFlag(args, "model") ? { model: stringFlag(args, "model") as string } : {}),
      }
      const home = resolveHome(deps.env ?? process.env, os.homedir())
      const to = now()
      const report = await readProviderUsage({
        config,
        executor,
        home,
        ...(providerId ? { providerId } : {}),
        from: to - days * 24 * 60 * 60 * 1000,
        to,
        now,
        ...(deps.ensureDb ? { ensureDb: deps.ensureDb } : {}),
        ...(deps.fsx ? { fsx: deps.fsx } : {}),
        ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
      })
      // Filters are applied to the REPORT, not inside the reader, so the
      // `--json` payload and the printed table are the same rows and cannot
      // disagree about what a filter meant.
      const filtered = {
        ...report,
        ledger: { ...report.ledger, rows: applyFilters(report.ledger.rows, filters) },
        sessions: { ...report.sessions, rows: applyFilters(report.sessions.rows, filters) },
      }
      const sources: SourceDiagnostic[] = deps.usageSources ? await deps.usageSources() : []

      if (json) {
        out.json({ verb, transport: transport.kind, scope, ...filtered, sources })
        return 0
      }
      const report2 = filtered
      out.write(
        `Usage ${new Date(report2.from).toISOString().slice(0, 10)} to ${new Date(report2.to).toISOString().slice(0, 10)} (${scope})\n`
      )
      out.write(`\nRecorded ledger (exact attribution)\n`)
      if (report2.ledger.unavailable) {
        out.write(`  local database unavailable: ${report2.ledger.unavailable}\n`)
      } else if (report2.ledger.rows.length === 0) {
        out.write(`  (no rows)\n`)
      }
      for (const row of report2.ledger.rows) out.write(`  ${formatUsageRow(row)}\n`)
      for (const failure of report2.ledger.failures) {
        out.write(`  ${failure.providerId}: ${failure.failure.failure.message}\n`)
      }
      out.write(
        `\nCLI sessions (${report2.sessions.scanned} in window, ${report2.sessions.withoutUsage} without usage)\n`
      )
      if (report2.sessions.rows.length === 0) out.write(`  (no rows)\n`)
      for (const row of report2.sessions.rows) out.write(`  ${formatUsageRow(row)}\n`)
      if (sources.length > 0) {
        out.write(`\nExternal agents\n`)
        for (const source of sources) out.write(`${formatSourceDiagnostic(source)}\n`)
      }
      if (report2.sessions.catalogAttributed + report2.sessions.approximate > 0) {
        out.write(
          `\n  c = provider attributed from the model catalog, ~ = approximate (alias shared by several providers, or unknown)\n`
        )
      }
      return 0
    }

    case "probe": {
      const report = await probeProviders({
        config,
        executor,
        transport,
        ...(providerId ? { providerId } : {}),
        ...(stringFlag(args, "model") ? { model: stringFlag(args, "model") } : {}),
        ...(numberFlag(args, "timeout") ? { timeoutMs: numberFlag(args, "timeout") } : {}),
      })
      const anyFailure =
        report.via === "gateway"
          ? report.rows.some((row) => !row.ok)
          : report.rows.some((row) => row.failure || !row.result?.reachable)
      if (json) {
        out.json({ verb, skipped: resolution.skipped, ...report })
        return anyFailure ? 1 : 0
      }
      out.write(`${transportHeader(resolution)}\n`)
      if (report.via === "gateway") {
        out.write(`Gateway probe for ${report.model} (${report.rows.length} candidates)\n`)
        for (const row of report.rows) out.write(`  ${formatGatewayProbeRow(row)}\n`)
        if (report.rows.length === 0)
          out.write(`  (no candidate: the gateway has no route for this model)\n`)
      } else {
        if (report.degraded) out.write(`Note: ${report.degraded}\n`)
        for (const row of report.rows) out.write(`  ${formatLocalProbeRow(row)}\n`)
        if (report.rows.length === 0) out.write(`  (no configured provider to probe)\n`)
      }
      return anyFailure ? 1 : 0
    }
  }
}
