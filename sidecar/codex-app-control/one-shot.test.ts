import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import test from "node:test"

import { parseOneShotArgs, runOneShot } from "./one-shot.ts"
import type { CommandResult } from "./shared.ts"

const okResult: CommandResult = {
  ok: true,
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  error: null,
}

/** A child that exits (or errors) on the next tick. */
function fakeChild(outcome: {
  exit?: [number | null, NodeJS.Signals | null]
  error?: Error
}): ChildProcess {
  const child = new EventEmitter()
  setImmediate(() => {
    if (outcome.error) child.emit("error", outcome.error)
    else child.emit("exit", ...(outcome.exit ?? [0, null]))
  })
  return child as unknown as ChildProcess
}

test("parseOneShotArgs takes the label and everything after --", () => {
  assert.deepEqual(parseOneShotArgs(["--label", "job", "--", "/bin/echo", "a", "b"]), {
    label: "job",
    command: "/bin/echo",
    args: ["a", "b"],
  })
  assert.throws(() => parseOneShotArgs(["--", "/bin/echo"]), /--label is required/)
  assert.throws(() => parseOneShotArgs(["--label", "job"]), /A command is required after --/)
})

test("runOneShot runs the child once, removes the launchd job, and reports its status", async () => {
  const commands: string[][] = []
  const spawned: string[][] = []
  const status = await runOneShot(["--label", "job", "--", "/bin/worker", "--x"], {
    spawn: (command, args) => {
      spawned.push([command, ...args])
      return fakeChild({ exit: [3, null] })
    },
    commandResult: (command, args) => {
      commands.push([command, ...args])
      return okResult
    },
    writeStderr: () => {},
  })
  assert.equal(status, 3)
  assert.deepEqual(spawned, [["/bin/worker", "--x"]])
  assert.deepEqual(commands, [["/bin/launchctl", "remove", "job"]])
})

test("runOneShot reports spawn errors, signals and a failed removal on stderr", async () => {
  const stderr: string[] = []
  const failed = await runOneShot(["--label", "job", "--", "/missing"], {
    spawn: () => fakeChild({ error: new Error("spawn ENOENT") }),
    commandResult: () => ({ ...okResult, ok: false, stderr: "no such job" }),
    writeStderr: (text) => stderr.push(text),
  })
  assert.equal(failed, 1)
  assert.deepEqual(stderr, ["spawn ENOENT\n", "no such job\n"])

  stderr.length = 0
  const signalled = await runOneShot(["--label", "job", "--", "/bin/worker"], {
    spawn: () => fakeChild({ exit: [null, "SIGTERM"] }),
    commandResult: () => okResult,
    writeStderr: (text) => stderr.push(text),
  })
  assert.equal(signalled, 1)
  assert.deepEqual(stderr, ["Worker exited from signal SIGTERM\n"])
})
