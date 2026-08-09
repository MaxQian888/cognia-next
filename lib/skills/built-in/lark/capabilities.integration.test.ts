import { spawnSync } from "node:child_process"
import {
  __resetLarkCliCapabilityCacheForTests,
  CERTIFIED_LARK_CLI_VERSION,
  probeLarkCliCapabilities,
} from "./capabilities"
import { __setLarkCliProcessRunnerForTests } from "./process"

const binary = process.env.LARK_CLI_BIN || "lark-cli"
const detected = spawnSync(binary, ["--version"], { encoding: "utf8" })
const integrationIt = detected.status === 0 ? it : it.skip

beforeAll(() => {
  __setLarkCliProcessRunnerForTests(async (command, args, options) => {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      maxBuffer: options.maxOutputBytes,
      timeout: options.timeoutMs,
    })
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
      ...(typeof result.status === "number" ? { exitCode: result.status } : {}),
      ...(result.error && "code" in result.error && result.error.code === "ENOENT"
        ? { notFound: true }
        : {}),
      ...(result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
        ? { timedOut: true }
        : {}),
    }
  })
})

afterAll(() => __setLarkCliProcessRunnerForTests(null))

integrationIt("probes every certified command and required flag", async () => {
  __resetLarkCliCapabilityCacheForTests()
  await expect(probeLarkCliCapabilities()).resolves.toMatchObject({
    ready: true,
    detectedVersion: CERTIFIED_LARK_CLI_VERSION,
    missingCommands: [],
    missingFlags: {},
    affectedSkillIds: [],
  })
})

integrationIt("accepts the certified native Sheets dry-run contracts", () => {
  expect(`${detected.stdout}${detected.stderr}`).toContain(CERTIFIED_LARK_CLI_VERSION)
  const cases = [
    [
      "sheets",
      "+cells-get",
      "--spreadsheet-token",
      "sht_test",
      "--sheet-id",
      "sheet1",
      "--range",
      "A1:B2",
    ],
    [
      "sheets",
      "+cells-search",
      "--spreadsheet-token",
      "sht_test",
      "--sheet-id",
      "sheet1",
      "--find",
      "needle",
    ],
    ["sheets", "+workbook-create", "--title", "Test", "--values", "[[1,2]]"],
    [
      "sheets",
      "+cells-set",
      "--spreadsheet-token",
      "sht_test",
      "--sheet-id",
      "sheet1",
      "--range",
      "A1",
      "--cells",
      '[[{"value":1}]]',
    ],
    [
      "sheets",
      "+table-put",
      "--spreadsheet-token",
      "sht_test",
      "--sheets",
      '{"sheets":[{"name":"Sheet1","columns":["A"],"data":[[1]],"header":false,"mode":"append"}]}',
    ],
    ["sheets", "+workbook-export", "--spreadsheet-token", "sht_test", "--file-extension", "xlsx"],
  ]
  for (const args of cases) {
    const result = spawnSync(binary, [...args, "--dry-run"], { encoding: "utf8" })
    expect({ args: args.join(" "), status: result.status, stderr: result.stderr }).toMatchObject({
      status: 0,
    })
  }
})

integrationIt("accepts dry-run argument contracts for all 40 registered Lark skills", () => {
  const isoStart = "2026-08-08T09:00:00+08:00"
  const isoEnd = "2026-08-08T10:00:00+08:00"
  const cases: Array<[string, string[]]> = [
    ["lark.base.search", ["base", "+title-resolve", "--title", "Test"]],
    ["lark.base.list_tables", ["base", "+table-list", "--base-token", "bas_test"]],
    [
      "lark.base.list_records",
      ["base", "+record-list", "--base-token", "bas_test", "--table-id", "tbltest"],
    ],
    [
      "lark.base.read_record",
      [
        "base",
        "+record-get",
        "--base-token",
        "bas_test",
        "--table-id",
        "tbltest",
        "--record-id",
        "rectest",
      ],
    ],
    [
      "lark.base.append_records",
      [
        "base",
        "+record-batch-create",
        "--base-token",
        "bas_test",
        "--table-id",
        "tbltest",
        "--json",
        '{"create_records":[{"Name":"Test"}]}',
      ],
    ],
    [
      "lark.base.update_record",
      [
        "base",
        "+record-batch-update",
        "--base-token",
        "bas_test",
        "--table-id",
        "tbltest",
        "--json",
        '{"update_records":{"rectest":{"Name":"Test"}}}',
      ],
    ],
    [
      "lark.base.create_field",
      [
        "base",
        "+field-create",
        "--base-token",
        "bas_test",
        "--table-id",
        "tbltest",
        "--json",
        '{"name":"Status","type":"text"}',
      ],
    ],
    [
      "lark.base.delete_record",
      [
        "base",
        "+record-delete",
        "--base-token",
        "bas_test",
        "--table-id",
        "tbltest",
        "--record-id",
        "rectest",
      ],
    ],
    ["lark.calendar.agenda_today", ["calendar", "+agenda"]],
    [
      "lark.calendar.list_events",
      [
        "calendar",
        "+search-event",
        "--calendar-id",
        "primary",
        "--start",
        isoStart,
        "--end",
        isoEnd,
      ],
    ],
    [
      "lark.calendar.freebusy",
      ["calendar", "+freebusy", "--user-id", "ou_test", "--start", isoStart, "--end", isoEnd],
    ],
    [
      "lark.calendar.search_rooms",
      ["calendar", "+room-find", "--room-name", "Boardroom", "--slot", `${isoStart}~${isoEnd}`],
    ],
    [
      "lark.calendar.create_event",
      [
        "calendar",
        "+create",
        "--calendar-id",
        "primary",
        "--summary",
        "Test",
        "--start",
        isoStart,
        "--end",
        isoEnd,
      ],
    ],
    [
      "lark.calendar.update_event",
      [
        "calendar",
        "+update",
        "--calendar-id",
        "primary",
        "--event-id",
        "event_test",
        "--summary",
        "Updated",
      ],
    ],
    [
      "lark.calendar.rsvp",
      [
        "calendar",
        "+rsvp",
        "--calendar-id",
        "primary",
        "--event-id",
        "event_test",
        "--rsvp-status",
        "accept",
      ],
    ],
    [
      "lark.calendar.book_room",
      [
        "calendar",
        "+update",
        "--calendar-id",
        "primary",
        "--event-id",
        "event_test",
        "--add-attendee-ids",
        "omm_test",
      ],
    ],
    [
      "lark.calendar.delete_event",
      ["calendar", "events", "delete", "--calendar-id", "primary", "--event-id", "event_test"],
    ],
    ["lark.doc.search", ["docs", "+search", "--query", "Test", "--page-size", "10"]],
    ["lark.doc.fetch", ["docs", "+fetch", "--doc", "docx_test", "--scope", "full"]],
    [
      "lark.doc.create",
      ["docs", "+create", "--title", "Test", "--content", "Hello", "--doc-format", "markdown"],
    ],
    [
      "lark.doc.update",
      ["docs", "+update", "--doc", "docx_test", "--command", "append", "--content", "Hello"],
    ],
    [
      "lark.doc.upload_image",
      [
        "docs",
        "+media-insert",
        "--doc",
        "docx_test",
        "--file",
        "public/icons/icon-192.png",
        "--type",
        "image",
      ],
    ],
    ["lark.doc.delete", ["drive", "+delete", "--file-token", "docx_test", "--type", "docx"]],
    [
      "lark.sheets.read_range",
      [
        "sheets",
        "+cells-get",
        "--spreadsheet-token",
        "sht_test",
        "--sheet-id",
        "sheet1",
        "--range",
        "A1:B2",
      ],
    ],
    [
      "lark.sheets.find",
      [
        "sheets",
        "+cells-search",
        "--spreadsheet-token",
        "sht_test",
        "--sheet-id",
        "sheet1",
        "--find",
        "needle",
      ],
    ],
    [
      "lark.sheets.create",
      [
        "sheets",
        "+workbook-create",
        "--title",
        "Test",
        "--sheets",
        '{"sheets":[{"name":"Sheet1","header":false,"columns":["column_1"],"data":[[1]]}]}',
      ],
    ],
    [
      "lark.sheets.write_range",
      [
        "sheets",
        "+cells-set",
        "--spreadsheet-token",
        "sht_test",
        "--sheet-id",
        "sheet1",
        "--range",
        "A1",
        "--cells",
        '[[{"value":1}]]',
      ],
    ],
    [
      "lark.sheets.append_rows",
      [
        "sheets",
        "+table-put",
        "--spreadsheet-token",
        "sht_test",
        "--sheets",
        '{"sheets":[{"name":"Sheet1","columns":["column_1"],"data":[[1]],"header":false,"mode":"append"}]}',
      ],
    ],
    [
      "lark.sheets.export",
      [
        "sheets",
        "+workbook-export",
        "--spreadsheet-token",
        "sht_test",
        "--file-extension",
        "xlsx",
        "--output-path",
        "/tmp/test.xlsx",
      ],
    ],
    ["lark.task.list_my_tasks", ["task", "+get-my-tasks", "--page-limit", "10"]],
    ["lark.task.get_task", ["task", "tasks", "get", "--task-guid", "task_test"]],
    ["lark.task.create", ["task", "+create", "--summary", "Test"]],
    ["lark.task.complete", ["task", "+complete", "--task-id", "task_test"]],
    ["lark.task.update", ["task", "+update", "--task-id", "task_test", "--summary", "Updated"]],
    ["lark.task.assign", ["task", "+assign", "--task-id", "task_test", "--add", "ou_test"]],
    [
      "lark.task.add_to_tasklist",
      ["task", "+tasklist-task-add", "--task-id", "task_test", "--tasklist-id", "tasklist_test"],
    ],
    [
      "lark.wiki.search_nodes",
      ["docs", "+search", "--query", "Test", "--filter", '{"space_id":"space_test"}'],
    ],
    [
      "lark.wiki.read_node",
      ["wiki", "+node-get", "--space-id", "space_test", "--node-token", "wiki_test"],
    ],
    [
      "lark.wiki.create_node",
      ["wiki", "+node-create", "--space-id", "space_test", "--title", "Test", "--obj-type", "docx"],
    ],
    [
      "lark.wiki.move_node",
      [
        "wiki",
        "+move",
        "--source-space-id",
        "space_test",
        "--node-token",
        "wiki_test",
        "--target-parent-token",
        "wiki_parent",
      ],
    ],
  ]
  expect(cases).toHaveLength(40)

  for (const [skillId, args] of cases) {
    const result = spawnSync(binary, [...args, "--dry-run"], { encoding: "utf8" })
    const scopeBlocked = result.status === 3 && result.stderr.includes('"subtype": "missing_scope"')
    if (result.status !== 0 && !scopeBlocked) {
      throw new Error(
        `${skillId}: ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`
      )
    }
  }
})
