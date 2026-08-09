import { runLarkCliProcess } from "./process"

export const CERTIFIED_LARK_CLI_VERSION = "1.0.83"

export const LARK_CLI_CAPABILITY_MANIFEST = {
  "lark.base.search": ["base", "+title-resolve"],
  "lark.base.list_tables": ["base", "+table-list"],
  "lark.base.list_records": ["base", "+record-list"],
  "lark.base.read_record": ["base", "+record-get"],
  "lark.base.append_records": ["base", "+record-batch-create"],
  "lark.base.update_record": ["base", "+record-batch-update"],
  "lark.base.create_field": ["base", "+field-create"],
  "lark.base.delete_record": ["base", "+record-delete"],
  "lark.calendar.agenda_today": ["calendar", "+agenda"],
  "lark.calendar.list_events": ["calendar", "+search-event"],
  "lark.calendar.freebusy": ["calendar", "+freebusy"],
  "lark.calendar.search_rooms": ["calendar", "+room-find"],
  "lark.calendar.create_event": ["calendar", "+create"],
  "lark.calendar.update_event": ["calendar", "+update"],
  "lark.calendar.rsvp": ["calendar", "+rsvp"],
  "lark.calendar.book_room": ["calendar", "+update"],
  "lark.calendar.delete_event": ["calendar", "events", "delete"],
  "lark.doc.search": ["docs", "+search"],
  "lark.doc.fetch": ["docs", "+fetch"],
  "lark.doc.create": ["docs", "+create"],
  "lark.doc.update": ["docs", "+update"],
  "lark.doc.upload_image": ["docs", "+media-insert"],
  "lark.doc.delete": ["drive", "+delete"],
  "lark.sheets.read_range": ["sheets", "+cells-get"],
  "lark.sheets.find": ["sheets", "+cells-search"],
  "lark.sheets.create": ["sheets", "+workbook-create"],
  "lark.sheets.write_range": ["sheets", "+cells-set"],
  "lark.sheets.append_rows": ["sheets", "+table-put"],
  "lark.sheets.export": ["sheets", "+workbook-export"],
  "lark.task.list_my_tasks": ["task", "+get-my-tasks"],
  "lark.task.get_task": ["task", "tasks", "get"],
  "lark.task.create": ["task", "+create"],
  "lark.task.complete": ["task", "+complete"],
  "lark.task.update": ["task", "+update"],
  "lark.task.assign": ["task", "+assign"],
  "lark.task.add_to_tasklist": ["task", "+tasklist-task-add"],
  "lark.wiki.search_nodes": ["docs", "+search"],
  "lark.wiki.read_node": ["wiki", "+node-get"],
  "lark.wiki.create_node": ["wiki", "+node-create"],
  "lark.wiki.move_node": ["wiki", "+move"],
} as const satisfies Record<string, readonly string[]>

export const LARK_CLI_REQUIRED_FLAGS = {
  "lark.base.search": ["--title"],
  "lark.base.list_tables": ["--base-token"],
  "lark.base.list_records": ["--base-token", "--table-id"],
  "lark.base.read_record": ["--base-token", "--table-id", "--record-id"],
  "lark.base.append_records": ["--base-token", "--table-id", "--json"],
  "lark.base.update_record": ["--base-token", "--table-id", "--json"],
  "lark.base.create_field": ["--base-token", "--table-id", "--json"],
  "lark.base.delete_record": ["--base-token", "--table-id", "--record-id"],
  "lark.calendar.agenda_today": [],
  "lark.calendar.list_events": ["--calendar-id"],
  "lark.calendar.freebusy": ["--user-id", "--start", "--end"],
  "lark.calendar.search_rooms": ["--room-name", "--slot"],
  "lark.calendar.create_event": ["--calendar-id", "--summary", "--start", "--end"],
  "lark.calendar.update_event": ["--calendar-id", "--event-id"],
  "lark.calendar.rsvp": ["--calendar-id", "--event-id", "--rsvp-status"],
  "lark.calendar.book_room": ["--calendar-id", "--event-id", "--add-attendee-ids"],
  "lark.calendar.delete_event": ["--calendar-id", "--event-id"],
  "lark.doc.search": ["--query"],
  "lark.doc.fetch": ["--doc"],
  "lark.doc.create": ["--title", "--content", "--doc-format"],
  "lark.doc.update": ["--doc", "--command", "--content"],
  "lark.doc.upload_image": ["--doc", "--file", "--type"],
  "lark.doc.delete": ["--file-token", "--type"],
  "lark.sheets.read_range": ["--spreadsheet-token", "--sheet-id", "--range"],
  "lark.sheets.find": ["--spreadsheet-token", "--sheet-id", "--find"],
  "lark.sheets.create": ["--title"],
  "lark.sheets.write_range": ["--spreadsheet-token", "--sheet-id", "--range", "--cells"],
  "lark.sheets.append_rows": ["--spreadsheet-token", "--sheets"],
  "lark.sheets.export": ["--spreadsheet-token", "--file-extension"],
  "lark.task.list_my_tasks": [],
  "lark.task.get_task": ["--task-guid"],
  "lark.task.create": ["--summary"],
  "lark.task.complete": ["--task-id"],
  "lark.task.update": ["--task-id"],
  "lark.task.assign": ["--task-id", "--add"],
  "lark.task.add_to_tasklist": ["--task-id", "--tasklist-id"],
  "lark.wiki.search_nodes": ["--query"],
  "lark.wiki.read_node": ["--space-id", "--node-token"],
  "lark.wiki.create_node": ["--space-id", "--title"],
  "lark.wiki.move_node": ["--source-space-id", "--node-token", "--target-parent-token"],
} as const satisfies Record<keyof typeof LARK_CLI_CAPABILITY_MANIFEST, readonly string[]>

export const LARK_CLI_CERTIFICATION_MANIFEST = {
  certifiedVersion: CERTIFIED_LARK_CLI_VERSION,
  commands: LARK_CLI_CAPABILITY_MANIFEST,
  requiredFlags: LARK_CLI_REQUIRED_FLAGS,
} as const

export interface LarkCliCapabilityDiagnostics {
  certifiedVersion: string
  detectedVersion?: string
  ready: boolean
  missingCommands: string[]
  missingFlags: Record<string, string[]>
  affectedSkillIds: string[]
  message?: string
}

type Execute = (args: readonly string[]) => Promise<string>
let cached: Promise<LarkCliCapabilityDiagnostics> | undefined
let lastDiagnostics: LarkCliCapabilityDiagnostics | undefined

async function execute(args: readonly string[]): Promise<string> {
  const binary = process.env.LARK_CLI_BIN?.trim() || "lark-cli"
  const result = await runLarkCliProcess(binary, args, {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  })
  if (
    result.notFound ||
    result.timedOut ||
    (result.exitCode !== undefined && result.exitCode !== 0)
  ) {
    throw new Error(result.stderr || `lark-cli exited with code ${String(result.exitCode)}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

export function probeLarkCliCapabilities(
  run: Execute = execute
): Promise<LarkCliCapabilityDiagnostics> {
  if (run === execute && cached) return cached
  const task = probe(run).then((diagnostics) => {
    lastDiagnostics = diagnostics
    return diagnostics
  })
  if (run === execute) cached = task
  return task
}

export function getCachedLarkCliCapabilityDiagnostics(): LarkCliCapabilityDiagnostics | undefined {
  return lastDiagnostics
}

export function isLarkSkillCapabilityAvailable(skillId: string): boolean {
  if (!(skillId in LARK_CLI_CAPABILITY_MANIFEST)) return false
  return Boolean(lastDiagnostics?.ready && !lastDiagnostics.affectedSkillIds.includes(skillId))
}

export function __setLarkCliCapabilityDiagnosticsForTests(
  diagnostics: LarkCliCapabilityDiagnostics | undefined
): void {
  lastDiagnostics = diagnostics
}

async function probe(run: Execute): Promise<LarkCliCapabilityDiagnostics> {
  try {
    const versionOutput = await run(["--version"])
    const detectedVersion = /(?:version\s+)?(\d+\.\d+\.\d+)/i.exec(versionOutput)?.[1]
    const entries = Object.entries(LARK_CLI_CAPABILITY_MANIFEST)
    const checks = await Promise.all(
      entries.map(async ([skillId, command]) => {
        try {
          const help = await run([...command, "--help"])
          const missingFlags = LARK_CLI_REQUIRED_FLAGS[
            skillId as keyof typeof LARK_CLI_REQUIRED_FLAGS
          ].filter((flag) => !help.includes(flag))
          return { skillId, command: command.join(" "), missingFlags, missingCommand: false }
        } catch {
          return { skillId, command: command.join(" "), missingFlags: [], missingCommand: true }
        }
      })
    )
    const missingCommands = checks.filter((value) => value.missingCommand)
    const missingFlags = Object.fromEntries(
      checks
        .filter((value) => value.missingFlags.length > 0)
        .map((value) => [value.skillId, value.missingFlags])
    )
    const affected = checks.filter((value) => value.missingCommand || value.missingFlags.length > 0)
    const versionMatches = detectedVersion === CERTIFIED_LARK_CLI_VERSION
    return {
      certifiedVersion: CERTIFIED_LARK_CLI_VERSION,
      ...(detectedVersion ? { detectedVersion } : {}),
      ready: versionMatches && affected.length === 0,
      missingCommands: [...new Set(missingCommands.map((item) => item.command))],
      missingFlags,
      affectedSkillIds: versionMatches
        ? affected.map((item) => item.skillId)
        : entries.map(([skillId]) => skillId),
      ...(!versionMatches
        ? {
            message: `Expected lark-cli ${CERTIFIED_LARK_CLI_VERSION}, detected ${detectedVersion ?? "unknown"}.`,
          }
        : {}),
    }
  } catch (error) {
    return {
      certifiedVersion: CERTIFIED_LARK_CLI_VERSION,
      ready: false,
      missingCommands: [],
      missingFlags: {},
      affectedSkillIds: Object.keys(LARK_CLI_CAPABILITY_MANIFEST),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function assertLarkCliCommandAvailable(args: readonly string[]): Promise<void> {
  const expected = Object.values(LARK_CLI_CAPABILITY_MANIFEST).find((command) =>
    command.every((part, index) => args[index] === part)
  )
  if (!expected)
    throw new Error(
      `lark-cli command is not in the certified capability manifest: ${args.slice(0, 3).join(" ")}`
    )
  const diagnostics = await probeLarkCliCapabilities()
  if (!diagnostics.ready)
    throw new Error(
      diagnostics.message ??
        `lark-cli capability check failed; missing: ${diagnostics.missingCommands.join(", ")}`
    )
}

export function __resetLarkCliCapabilityCacheForTests(): void {
  cached = undefined
  lastDiagnostics = undefined
}
