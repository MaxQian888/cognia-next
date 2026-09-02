/**
 * Pure formatters for the `/provider …`, `/models` and `/balance` runtime
 * verbs. Every document renders through the existing markdown pager, and the
 * meter lines reuse the `/limits` helpers so a balance reads the same in the
 * panel and in the notice.
 */

import type { ProviderOperationCell, ProviderOperationProfile } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import type { ProviderCapabilitiesReport } from "../../provider/capabilities"
import type { ProviderModelsReport } from "../../provider/models"
import type { ProviderProbeReport } from "../../provider/probe"
import type { ProviderUsageReport } from "../../provider/usage"
import { meterLabel, meterResetText, meterRightLabel } from "./limits"

function cellDetail(cell: ProviderOperationCell): string {
  switch (cell.support) {
    case "unsupported":
      return cell.reason
    case "unknown":
      return `${cell.provenance}: ${cell.failure.message}`
    case "plugin":
      return `via ${cell.via}`
    default:
      return cell.note ?? ""
  }
}

/** Cells grouped by support, served first, as a markdown table. */
export function formatProfileTable(profile: ProviderOperationProfile): string {
  const order = ["native", "translated", "derived", "plugin", "unknown", "unsupported"]
  const rows = [...profile.cells].sort(
    (a, b) =>
      order.indexOf(a.support) - order.indexOf(b.support) ||
      a.operationId.localeCompare(b.operationId)
  )
  const lines = ["| Operation | Support | Availability | Detail |", "| --- | --- | --- | --- |"]
  for (const cell of rows) {
    lines.push(
      `| \`${cell.operationId}\` | ${cell.support} | ${cell.availability} | ${cellDetail(cell).replace(/\|/g, "\\|")} |`
    )
  }
  return lines.join("\n")
}

/** Support histogram, e.g. `38 served · 10 unsupported · 2 unknown`. */
export function summarizeProfile(profile: ProviderOperationProfile): string {
  let served = 0
  let unsupported = 0
  let unknown = 0
  for (const cell of profile.cells) {
    if (cell.support === "unsupported") unsupported += 1
    else if (cell.support === "unknown") unknown += 1
    else served += 1
  }
  return `${served} served · ${unsupported} unsupported · ${unknown} unknown`
}

export function formatCapabilitiesDocument(report: ProviderCapabilitiesReport): string {
  const out = [
    `# Provider capabilities`,
    "",
    `Transport: ${report.transportLabel}`,
    `Contract v${report.schemaVersion}: ${report.operationCount} operations` +
      (report.adminCommands.length
        ? `, desktop admin commands: ${report.adminCommands.map((c) => `\`${c}\``).join(", ")}`
        : ""),
  ]
  if (report.operationFilter) out.push(`Filter: \`${report.operationFilter}\``)
  for (const entry of report.providers) {
    out.push("", `## ${entry.providerId}`, "")
    if (entry.failure) {
      out.push(`${entry.failure.availability}: ${entry.failure.failure.message}`)
      continue
    }
    const profile = entry.profile!
    out.push(summarizeProfile(profile), "", formatProfileTable(profile))
  }
  return out.join("\n")
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function usageTable(rows: ProviderUsageReport["ledger"]["rows"]): string[] {
  if (rows.length === 0) return ["_(no rows)_"]
  const lines = [
    "| Provider | Model | Attribution | In | Out | Cost |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  for (const row of rows) {
    const cost = row.costKnown ? `$${row.costUsd.toFixed(4)}` : "unknown"
    lines.push(
      `| ${row.providerId ?? "?"} | \`${row.model}\` | ${row.attribution} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${cost} |`
    )
  }
  return lines
}

export function formatUsageDocument(report: ProviderUsageReport): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const out = [`# Provider usage ${day(report.from)} to ${day(report.to)}`, ""]
  out.push("## Recorded ledger (exact attribution)", "")
  if (report.ledger.unavailable) {
    out.push(`Local database unavailable: ${report.ledger.unavailable}`)
  } else {
    out.push(...usageTable(report.ledger.rows))
  }
  for (const failure of report.ledger.failures) {
    out.push(`- ${failure.providerId}: ${failure.failure.failure.message}`)
  }
  out.push(
    "",
    `## CLI sessions (${report.sessions.scanned} in window, ${report.sessions.withoutUsage} without usage)`,
    "",
    ...usageTable(report.sessions.rows)
  )
  if (report.sessions.catalogAttributed + report.sessions.approximate > 0) {
    out.push(
      "",
      "`catalog` rows were attributed from the model catalog. `approximate` rows are aliases several providers share, or models no configured provider lists."
    )
  }
  out.push("", "An unknown cost means no pricing layer knew the model. It is not free.")
  return out.join("\n")
}

export function formatProbeDocument(report: ProviderProbeReport): string {
  const out = ["# Provider probe", "", `Transport: ${report.transportLabel}`]
  if (report.via === "gateway") {
    out.push(`Gateway probe for \`${report.model}\` (${report.rows.length} candidates)`, "")
    if (report.rows.length === 0) {
      out.push("_(no candidate: the gateway has no route for this model)_")
    } else {
      out.push(
        "| | Provider | Model | Latency | Status | Error |",
        "| --- | --- | --- | --- | --- | --- |"
      )
      for (const row of report.rows) {
        out.push(
          `| ${row.ok ? "ok" : "FAIL"} | ${row.providerId} | \`${row.modelId}\` | ${row.latencyMs}ms | ${row.status ?? ""} | ${row.error ?? ""} |`
        )
      }
    }
    return out.join("\n")
  }
  if (report.degraded) out.push(`Note: ${report.degraded}`)
  out.push("")
  if (report.rows.length === 0) {
    out.push("_(no configured provider to probe)_")
    return out.join("\n")
  }
  out.push(
    "| | Provider | Latency | Auth | Status | Detail |",
    "| --- | --- | --- | --- | --- | --- |"
  )
  for (const row of report.rows) {
    if (row.failure) {
      out.push(
        `| FAIL | ${row.providerId} | | | ${row.failure.availability} | ${row.failure.failure.message} |`
      )
      continue
    }
    const r = row.result!
    const ok = r.reachable && r.authenticated !== false && !r.failure
    const auth = r.authenticated === undefined ? "" : r.authenticated ? "yes" : "no"
    out.push(
      `| ${ok ? "ok" : "FAIL"} | ${row.providerId} | ${r.durationMs}ms | ${auth} | ${r.httpStatus ?? ""} | ${r.failure?.message ?? ""} |`
    )
  }
  return out.join("\n")
}

export interface InspectDocumentInput {
  providerId: string
  transportLabel: string
  capabilities: ProviderCapabilitiesReport["providers"][number]
  models: ProviderModelsReport
}

export function formatInspectDocument(input: InspectDocumentInput): string {
  const out = [`# ${input.providerId}`, "", `Transport: ${input.transportLabel}`, ""]
  out.push("## Models", "")
  if (input.models.failure) {
    out.push(`${input.models.failure.availability}: ${input.models.failure.failure.message}`)
  } else {
    const listing = input.models.listing!
    out.push(
      `${listing.models.length} models (${listing.source}, ${listing.freshness}, fetched ${new Date(listing.fetchedAt).toISOString()})`,
      ""
    )
    for (const model of listing.models) {
      const name = model.name && model.name !== model.id ? ` ${model.name}` : ""
      const ctx = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k ctx` : ""
      out.push(`- \`${model.id}\`${name}${ctx}`)
    }
  }
  out.push("", "## Operations", "")
  if (input.capabilities.failure) {
    out.push(
      `${input.capabilities.failure.availability}: ${input.capabilities.failure.failure.message}`
    )
  } else {
    const profile = input.capabilities.profile!
    out.push(summarizeProfile(profile), "", formatProfileTable(profile))
  }
  return out.join("\n")
}

/** One line per meter across snapshots, for the notice under the panel. */
export function formatMeterSummary(snapshots: readonly ProviderLimits[], now: number): string {
  const lines: string[] = []
  for (const snapshot of snapshots) {
    const account = snapshot.accountLabel ?? snapshot.accountId ?? snapshot.provider
    if (snapshot.error) lines.push(`${account}: ${snapshot.error}`)
    for (const meter of snapshot.meters) {
      const reset = meterResetText(meter, now)
      lines.push(
        `${account}: ${meterLabel(meter)} ${meterRightLabel(meter)}${reset ? ` (${reset})` : ""}`
      )
    }
  }
  return lines.join("\n")
}
