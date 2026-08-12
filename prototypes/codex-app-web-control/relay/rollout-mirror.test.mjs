import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { findRolloutByThreadId, projectRolloutRecord } from "./rollout-mirror.mjs"

test("projectRolloutRecord keeps user and assistant messages", () => {
  assert.deepEqual(
    projectRolloutRecord({
      timestamp: "2026-08-12T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello" },
    }),
    {
      kind: "message",
      at: "2026-08-12T00:00:00.000Z",
      role: "user",
      text: "hello",
    }
  )
  assert.equal(
    projectRolloutRecord({
      timestamp: "2026-08-12T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "world", phase: "final" },
    })?.role,
    "assistant"
  )
})

test("projectRolloutRecord exposes tool lifecycle without raw internal records", () => {
  assert.deepEqual(
    projectRolloutRecord({
      timestamp: "2026-08-12T00:00:00.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "{}" },
    }),
    {
      kind: "tool",
      at: "2026-08-12T00:00:00.000Z",
      status: "started",
      name: "exec",
      callId: "call-1",
      input: "{}",
    }
  )
  assert.equal(projectRolloutRecord({ type: "turn_context", payload: {} }), null)
})

test("findRolloutByThreadId locates an App-owned task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-rollout-test-"))
  const day = join(root, "2026", "08", "12")
  await mkdir(day, { recursive: true })
  const rollout = join(day, "rollout.jsonl")
  await writeFile(
    rollout,
    `${JSON.stringify({ type: "session_meta", payload: { id: "019ff223-2480-7c01-bdb2-6e6305ca8f1c" } })}\n`
  )
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })

  assert.equal(await findRolloutByThreadId(root, "019ff223-2480-7c01-bdb2-6e6305ca8f1c"), rollout)
})
