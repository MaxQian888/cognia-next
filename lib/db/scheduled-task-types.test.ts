/**
 * The scheduler's stored row shapes.
 *
 * The check that earns its keep here is index-vs-shape. Dexie silently ignores
 * an index whose keyPath is never present on a row, and the query that needed
 * it then returns nothing rather than erroring, so a schema index without a
 * matching field is a lookup that quietly answers "none". Both of this table's
 * denormalized discriminators exist precisely to be indexed, which makes that
 * failure mode the likely one.
 */

import type { DBScheduledTask, DBTaskExecution } from "./scheduled-task-types"

function task(overrides: Partial<DBScheduledTask> = {}): DBScheduledTask {
  return {
    id: "task-1",
    name: "Morning digest",
    type: "chat",
    trigger: JSON.stringify({ type: "cron", cronExpression: "0 9 * * *" }),
    eventType: "",
    config: JSON.stringify({}),
    notification: JSON.stringify({}),
    createdBySource: "user",
    status: "active",
    nextRunAt: "2026-09-05T09:00:00.000Z",
    projectId: "proj-1",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

function execution(overrides: Partial<DBTaskExecution> = {}): DBTaskExecution {
  return {
    id: "run-1",
    taskId: "task-1",
    taskName: "Morning digest",
    taskType: "chat",
    status: "completed",
    retryAttempt: 0,
    startedAt: "2026-09-02T09:00:00.000Z",
    logs: "[]",
    ...overrides,
  }
}

async function indexedFields(table: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises")
  const schema = await readFile("lib/db/schema.ts", "utf8")
  // The declaration wraps across lines in the source, so match non-greedily
  // through the whole string literal rather than assuming one line.
  const declaration = new RegExp(`\\n  ${table}:\\s*\\n?\\s*"([^"]+)"`).exec(schema)
  expect(declaration).not.toBeNull()
  return (declaration?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^&/, ""))
    .flatMap((entry) =>
      entry.startsWith("[")
        ? entry
            .slice(1, -1)
            .split("+")
            .map((part) => part.trim())
        : [entry]
    )
}

describe("DBScheduledTask", () => {
  it("carries every field the schema declares an index on", async () => {
    const indexed = await indexedFields("scheduledTasks")
    const sample = task() as unknown as Record<string, unknown>
    for (const field of indexed) {
      expect(sample[field]).toBeDefined()
    }
  })

  it("keeps both denormalized discriminators, because their sources are encrypted", async () => {
    const indexed = await indexedFields("scheduledTasks")
    // `trigger` and `createdBy` are JSON blobs inside the encrypted payload
    // after schema v219. Without these two columns an event lookup and a
    // per-source quota would each mean decrypting every row.
    expect(indexed).toContain("eventType")
    expect(indexed).toContain("createdBySource")
    expect(Object.keys(task())).toContain("eventType")
    expect(Object.keys(task())).toContain("createdBySource")
  })

  it("stores dates as ISO strings, so lexicographic order matches chronological", () => {
    // `[status+nextRunAt]` is range-queried by the overdue sweep, and that only
    // works because the values are fixed-width ISO-8601 rather than epoch
    // numbers or locale strings.
    const sample = task()
    for (const value of [sample.createdAt, sample.updatedAt, sample.nextRunAt]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })
})

describe("DBTaskExecution", () => {
  it("carries every field the schema declares an index on", async () => {
    const indexed = await indexedFields("scheduledTaskRuns")
    const sample = execution() as unknown as Record<string, unknown>
    for (const field of indexed) {
      expect(sample[field]).toBeDefined()
    }
  })

  it("keeps the terminal reason optional but present in the shape", () => {
    // It is what distinguishes "the host cannot run this" from "the executor
    // failed", and the run detail sheet has nothing else to show for a task
    // that never actually ran.
    expect(execution({ terminalReason: "unsupported-on-host" }).terminalReason).toBe(
      "unsupported-on-host"
    )
  })
})
