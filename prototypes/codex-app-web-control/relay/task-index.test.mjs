import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import { listCodexTasks } from "./task-index.mjs"

function seedDatabase(path) {
  const database = new DatabaseSync(path)
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT, preview TEXT NOT NULL,
    first_user_message TEXT NOT NULL, cwd TEXT NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER NOT NULL,
    archived INTEGER NOT NULL, is_pinned INTEGER NOT NULL,
    source TEXT NOT NULL, model TEXT
  )`)
  const insert = database.prepare(
    `INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insert.run(
    "019ff111-1111-7111-8111-111111111111",
    "Generated title",
    "Renamed task",
    "preview one",
    "first",
    "/repo",
    1000,
    5000,
    5000,
    0,
    1,
    "vscode",
    "gpt-test"
  )
  insert.run(
    "019ff222-2222-7222-8222-222222222222",
    "Second task",
    null,
    "preview two",
    "first",
    "/repo",
    2000,
    4000,
    4000,
    0,
    0,
    "vscode",
    "gpt-test"
  )
  insert.run(
    "019ff333-3333-7333-8333-333333333333",
    "Archived task",
    null,
    "archived",
    "first",
    "/repo",
    3000,
    3000,
    3000,
    1,
    0,
    "vscode",
    null
  )
  insert.run(
    "019ff444-4444-7444-8444-444444444444",
    "Other workspace",
    null,
    "other",
    "first",
    "/other",
    4000,
    6000,
    6000,
    0,
    0,
    "vscode",
    null
  )
  insert.run(
    "019ff555-5555-7555-8555-555555555555",
    "Guardian",
    null,
    "hidden",
    "first",
    "/repo",
    5000,
    7000,
    7000,
    0,
    0,
    '{"subagent":{"other":"guardian"}}',
    null
  )
  database.close()
}

test("task index returns UUID/title metadata with workspace, archive, and subagent filters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-task-index-"))
  const databasePath = join(root, "state.sqlite")
  seedDatabase(databasePath)

  const result = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", archived: "active", limit: 20 },
    { databasePath }
  )

  assert.equal(result.source, "state-db")
  assert.equal(result.total, 2)
  assert.deepEqual(
    result.tasks.map((task) => task.id),
    ["019ff111-1111-7111-8111-111111111111", "019ff222-2222-7222-8222-222222222222"]
  )
  assert.equal(result.tasks[0].title, "Renamed task")
  assert.equal(result.tasks[0].generatedTitle, "Generated title")
  assert.equal(result.tasks[0].pinned, true)
  assert.equal("rolloutPath" in result.tasks[0], false)

  const archived = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", archived: "archived" },
    { databasePath }
  )
  assert.deepEqual(
    archived.tasks.map((task) => task.title),
    ["Archived task"]
  )

  const subagents = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", includeSubagents: true, query: "Guardian" },
    { databasePath }
  )
  assert.equal(subagents.tasks[0].title, "Guardian")
})

test("task index paginates deterministically and searches UUIDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cognia-task-index-"))
  const databasePath = join(root, "state.sqlite")
  seedDatabase(databasePath)

  const first = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", limit: 1 },
    { databasePath }
  )
  assert.equal(first.tasks.length, 1)
  assert.ok(first.nextCursor)
  const second = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", limit: 1, cursor: first.nextCursor },
    { databasePath }
  )
  assert.equal(second.tasks[0].title, "Second task")

  const searched = await listCodexTasks(
    { workspace: "/repo", scope: "workspace", query: "019ff222" },
    { databasePath }
  )
  assert.deepEqual(
    searched.tasks.map((task) => task.title),
    ["Second task"]
  )
  await assert.rejects(
    listCodexTasks({ workspace: "/repo", scope: "workspace", cursor: "invalid" }, { databasePath }),
    /cursor is invalid/
  )
})

test("task index falls back to session_index.jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "cognia-task-index-"))
  const indexPath = join(root, "session_index.jsonl")
  await writeFile(
    indexPath,
    `${JSON.stringify({ id: "019ff666-6666-7666-8666-666666666666", thread_name: "Fallback title", updated_at: "2026-08-12T00:00:00Z" })}\n`
  )

  const result = await listCodexTasks(
    { workspace: "/repo", scope: "workspace" },
    { databasePath: join(root, "missing.sqlite"), indexPath }
  )
  assert.equal(result.source, "session-index")
  assert.equal(result.degraded, true)
  assert.equal(result.tasks[0].title, "Fallback title")
})
