import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexTaskDeepLink } from "./cdp-bootstrap.ts"

test("new App-owned tasks do not attach Browser context unless explicitly requested", () => {
  const plain = new URL(
    buildCodexTaskDeepLink({
      prompt: "hello",
      workspace: "/tmp",
      nonce: "plain-task",
    })
  )
  const browser = new URL(
    buildCodexTaskDeepLink({
      prompt: "inspect",
      browserUrl: "https://example.com",
      workspace: "/tmp",
      nonce: "browser-task",
    })
  )

  assert.equal(plain.searchParams.has("browserUrl"), false)
  assert.equal(browser.searchParams.get("browserUrl"), "https://example.com/")
})

import { dispatch, normalizedInput, readInput, runControlCli, taskAsThread } from "./cli.ts"

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part
}

test("runtime-path discovers the installed CLI without requiring or restarting CDP", async () => {
  assert.deepEqual(await dispatch("runtime-path", {}, () => "/bundle/codex"), {
    executable: "/bundle/codex",
  })
  await assert.rejects(
    dispatch("runtime-path", {}, () => {
      throw new Error("bundled Codex runtime missing")
    }),
    /bundled Codex runtime missing/
  )
})

test("normalizedInput folds text, remote media and skills into one prompt plus local files", () => {
  assert.deepEqual(
    normalizedInput([
      { type: "text", text: " first " },
      { type: "image", url: "https://example.com/a.png" },
      { type: "localImage", path: "/tmp/a.png" },
      { type: "mention", path: "/tmp/a.png" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    ]),
    {
      prompt:
        "first\n\nhttps://example.com/a.png\n\nUse the installed review skill for this request.",
      filePaths: ["/tmp/a.png", "/skills/review/SKILL.md"],
    }
  )
  assert.deepEqual(normalizedInput([{ type: "localAudio", path: "/tmp/b.wav" }]), {
    prompt: "Use the attached local context for this request.",
    filePaths: ["/tmp/b.wav"],
  })
  assert.throws(() => normalizedInput([]), /input is required/)
  assert.throws(() => normalizedInput([{ type: "video" }]), /unsupported input type: video/)
})

test("taskAsThread reports an active status only while the last turn is running", () => {
  const task = { id: "t1", preview: "p", cwd: "/repo", createdAt: "2026-08-12T00:00:00.000Z" }
  assert.equal(taskAsThread(task).status.type, "idle")
  assert.equal(
    taskAsThread(task, [{ kind: "turn", at: null, status: "started", turnId: "u1" }]).status.type,
    "active"
  )
  assert.equal(taskAsThread(task).createdAt, Date.parse("2026-08-12T00:00:00.000Z") / 1000)
})

test("readInput parses one bounded JSON body; empty or non-object bodies read as {}", async () => {
  assert.deepEqual(await readInput(chunks('{"cwd":', '"/repo"}')), { cwd: "/repo" })
  assert.deepEqual(await readInput(chunks("  ")), {})
  assert.deepEqual(await readInput(chunks("[1,2]")), [1, 2])
  assert.deepEqual(await readInput(chunks("7")), {})
  await assert.rejects(readInput(chunks("x".repeat((8 << 20) + 1))), /control request is too large/)
})

test("runControlCli writes one JSON line and maps failures to exit code 1", async () => {
  const lines: string[] = []
  const write = (text: string) => lines.push(text)
  assert.equal(await runControlCli(["no-such-op"], { input: chunks("{}"), write }), 1)
  assert.equal(await runControlCli([], { input: chunks(""), write }), 1)
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { ok: false, error: "unknown Codex App control operation: no-such-op" },
      { ok: false, error: "operation is required" },
    ]
  )
  await assert.rejects(dispatch("task-list", {}), /cwd is required/)
})
