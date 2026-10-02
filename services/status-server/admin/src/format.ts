/**
 * Human-readable output. Only safe identifiers and operator-visible state are
 * printed: IDs, revisions, states, times, error codes. Never tokens, and the
 * API never returns subscriber addresses or mail bodies to begin with.
 */

import type { ReadView } from "./commands"

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}
}

function asList(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "object") {
    const localized = value as { en?: unknown }
    if (typeof localized.en === "string") return localized.en
    return JSON.stringify(value)
  }
  return String(value)
}

function ids(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : text(value)
}

function incidentLine(incident: Json): string {
  const flags = incident.pinned === true ? " [pinned]" : ""
  return [
    text(incident.id),
    `rev ${text(incident.revision)}`,
    text(incident.state),
    text(incident.impact),
    ids(incident.componentIds),
    `${text(incident.source)}${flags}`,
    `started ${text(incident.startedAt)}`,
    text(incident.title),
  ].join("  ")
}

function maintenanceLine(window: Json): string {
  return [
    text(window.id),
    `rev ${text(window.revision)}`,
    text(window.state),
    `${text(window.startsAt)} → ${text(window.endsAt)}`,
    window.actualEndAt ? `actual end ${text(window.actualEndAt)}` : null,
    ids(window.componentIds),
    window.excludeFromAvailability === true ? "excluded" : "counted",
    text(window.title),
  ]
    .filter((part) => part !== null)
    .join("  ")
}

export function renderRead(view: ReadView, body: unknown): string[] {
  const root = asRecord(body)
  switch (view) {
    case "incidents": {
      const lines = asList(root.incidents).map(incidentLine)
      if (lines.length === 0) lines.push("(no incidents)")
      if (root.nextCursor) lines.push(`next page: --cursor ${text(root.nextCursor)}`)
      return lines
    }
    case "incident": {
      const incident = asRecord(root.incident)
      const lines = [incidentLine(incident)]
      if (incident.manualOwner) lines.push(`owner: ${text(incident.manualOwner)}`)
      if (incident.predecessorId) lines.push(`follows: ${text(incident.predecessorId)}`)
      for (const update of asList(incident.updates)) {
        const correction = update.correctionOf ? ` (corrects ${text(update.correctionOf)})` : ""
        lines.push(
          `  ${text(update.at)}  ${text(update.id)}  ${text(update.state)}  ${text(update.source)}${correction}: ${text(update.message)}`
        )
      }
      return lines
    }
    case "maintenance": {
      const lines = asList(root.maintenance).map(maintenanceLine)
      if (lines.length === 0) lines.push("(no maintenance windows)")
      if (root.nextCursor) lines.push(`next page: --cursor ${text(root.nextCursor)}`)
      return lines
    }
    case "probes": {
      const lines = asList(root.probes).map((probe) =>
        [
          text(probe.id),
          text(probe.source),
          probe.reference === true ? "reference" : "witness",
          `health ${text(probe.health)}`,
          probe.disabled === true ? "DISABLED" : "enabled",
          `keys ${ids(probe.keyIds)}`,
          `last success ${text(probe.lastSuccessAt)}`,
          text(probe.label),
        ].join("  ")
      )
      return lines.length > 0 ? lines : ["(no probes)"]
    }
    case "deliveries": {
      const lines = asList(root.deliveries).map((row) =>
        [
          text(row.id),
          text(row.state),
          `attempts ${text(row.attempts)}`,
          `error ${text(row.lastErrorCode)}`,
          `provider ${text(row.providerMessageId)}`,
          `event ${text(row.eventId)}`,
          `updated ${text(row.updatedAt)}`,
        ].join("  ")
      )
      return lines.length > 0 ? lines : ["(no deliveries)"]
    }
  }
}

/** Safe summary of a successful write. */
export function renderWriteResult(body: unknown): string[] {
  const root = asRecord(body)
  if (root.incident) return [incidentLine(asRecord(root.incident))]
  if (root.maintenance) return [maintenanceLine(asRecord(root.maintenance))]
  if (root.delivery) {
    const row = asRecord(root.delivery)
    return [`${text(row.id)}  ${text(row.state)}  next attempt ${text(row.nextAttemptAt)}`]
  }
  const parts = Object.entries(root)
    .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `${key}=${text(value)}`)
  return parts.length > 0 ? [parts.join("  ")] : ["(no details)"]
}

export function renderError(status: number, body: unknown): string[] {
  const root = asRecord(body)
  const lines = [
    `Error ${status}: ${text(root.code ?? "unknown")}${root.reason ? ` (${text(root.reason)})` : ""}`,
  ]
  if (root.requestId) lines.push(`requestId: ${text(root.requestId)}`)
  if (typeof root.currentRevision === "number") {
    lines.push(
      `currentRevision: ${root.currentRevision} — re-read the object and retry with --revision ${root.currentRevision} if the change still applies`
    )
  }
  return lines
}

export const USAGE = `Usage: cognia-status-admin <group> <command> [options]

Global options:
  --api <url>            API base (default: $STATUS_API_BASE or https://status.cognia.cn/api/status/v1)
  --yes                  send without the interactive confirmation
  --operation-id <id>    reuse an operation ID (idempotent retry of an earlier write)
  --json                 print the raw JSON response

Auth: $CF_ACCESS_TOKEN, or \`cloudflared access token -app=<api origin>\` after
\`cloudflared access login <api origin>\`.

Commands:
  incident create --title-en <t> [--title-zh <t>] --message-en <m> [--message-zh <m>]
                  --impact degraded|partial_outage|major_outage --components a,b
                  [--state investigating|identified|monitoring]
  incident update <id> --revision <n> --message-en <m> [--message-zh <m>] [--state <s>]
                  [--impact <i>] [--components a,b] [--pin|--unpin] [--correction-of <update-id>]
  incident resolve <id> --revision <n> --message-en <m> [--message-zh <m>] --reason <text>
  incident list [--limit <n>] [--cursor <c>]
  incident show <id>
  maintenance schedule --title-en <t> [--title-zh <t>] --description-en <d> [--description-zh <d>]
                  --components a,b --starts-at <iso> --ends-at <iso> (--exclude|--no-exclude)
  maintenance extend <id> --revision <n> --ends-at <iso> [--message-en <m>] [--message-zh <m>]
  maintenance reschedule <id> --revision <n> --starts-at <iso> --ends-at <iso> [--message-en <m>]
  maintenance complete <id> --revision <n> [--message-en <m>] [--message-zh <m>]
  maintenance cancel <id> --revision <n> [--message-en <m>] [--message-zh <m>]
  maintenance list [--limit <n>] [--cursor <c>]
  probe list
  probe enroll --probe-id <id> [--source external|cloudflare] --label-en <l> [--label-zh <l>]
                  [--location-en <l>] [--location-zh <l>] [--provider <p>] --enrolled-at <iso>
                  --profile <id>:<http s|->:<protocol s|-> [--profile …] --key-id <id>
  probe disable <id> --reason <text>
  probe enable <id> --reason <text>
  probe set-reference <id> --effective-at <iso> --reason <text>
  delivery inspect [--state <state>] [--limit <n>]
  delivery retry <outbox-id> [--acknowledge-uncertain]

Every write prints a preview of the exact request and asks before sending.`
