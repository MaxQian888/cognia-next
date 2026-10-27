import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { createVerificationBudget } from "../../../shared/verification-budget.ts"
import type { ToolResult } from "../../kernel/result.ts"
import { createVerificationBatchTool } from "./verification-batch.ts"

function fixture() {
  let time = 0
  const budget = createVerificationBudget({ epoch: () => 1000 + time, monotonic: () => time })
  budget.reset({ startedAtEpochMs: 1000, deadlineEpochMs: 361_000 })
  return {
    budget,
    advance(ms: number) {
      time += ms
    },
  }
}
function decode(result: ToolResult) {
  return JSON.parse(result.content.map((item) => ("text" in item ? item.text : "")).join("\n"))
}

test("batch executes every declared check and never certifies the whole task", async () => {
  const { budget } = fixture()
  const calls: unknown[] = []
  const batch = createVerificationBatchTool({
    cwd: os.tmpdir(),
    verificationBudget: budget,
    authorizeVerificationCommand: async (args) => {
      calls.push(args)
      return args
    },
  })
  const result = decode(
    await batch.handler({
      commands: [
        { label: "one", command: "echo check-one" },
        { label: "two", command: "echo check-two" },
      ],
    })
  )
  assert.equal(calls.length, 2)
  assert.equal(result.status, "batch_passed")
  assert.equal(result.allDeclaredCommandsExecuted, true)
  assert.equal(result.fullTaskValidationCertified, false)
})

test("failed commands stay failures while remaining declared checks execute", async () => {
  const { budget } = fixture()
  const batch = createVerificationBatchTool({
    cwd: os.tmpdir(),
    verificationBudget: budget,
    authorizeVerificationCommand: async (args) => args,
  })
  const result = decode(
    await batch.handler({
      commands: [
        { label: "fail", command: "exit 2" },
        { label: "next", command: "echo checked-next" },
      ],
    })
  )
  assert.equal(result.status, "batch_failed")
  assert.deepEqual(
    result.results.map((row: { status: string }) => row.status),
    ["failed", "passed"]
  )
})

test("approval changes cannot detach work or start after budget expiry", async () => {
  const f = fixture()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "verification-batch-"))
  try {
    const marker = path.join(directory, "never")
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}`
    const batch = createVerificationBatchTool({
      cwd: directory,
      verificationBudget: f.budget,
      authorizeVerificationCommand: async (args) => ({
        ...(args as object),
        run_in_background: true,
        detach: true,
      }),
    })
    const blocked = decode(await batch.handler({ commands: [{ label: "blocked", command }] }))
    assert.equal(blocked.status, "incomplete")
    assert.deepEqual(blocked.pending, ["blocked"])
    assert.match(blocked.results[0].reason, /cannot run in background/)
    const expired = createVerificationBatchTool({
      cwd: directory,
      verificationBudget: f.budget,
      authorizeVerificationCommand: async (args) => {
        f.advance(360_000)
        return args
      },
    })
    const stopped = decode(await expired.handler({ commands: [{ label: "pending", command }] }))
    assert.deepEqual(stopped.pending, ["pending"])
    await assert.rejects(fs.access(marker))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("a cancelled call or changed turn cannot launch the next command", async () => {
  const f = fixture()
  const abort = new AbortController()
  let approvals = 0
  const batch = createVerificationBatchTool({
    verificationBudget: f.budget,
    authorizeVerificationCommand: async (args) => {
      approvals++
      abort.abort()
      return args
    },
  })
  const result = decode(
    await batch.handler(
      {
        commands: [
          { label: "one", command: "echo never" },
          { label: "two", command: "echo never" },
        ],
      },
      { signal: abort.signal }
    )
  )
  assert.equal(approvals, 1)
  assert.equal(result.status, "incomplete")
  assert.deepEqual(result.pending, ["one", "two"])
  f.budget.reset(undefined)
  assert.equal(
    decode(await batch.handler({ commands: [{ label: "no time", command: "echo never" }] })).status,
    "incomplete"
  )
})

test("a hanging approval is aborted at the batch deadline", async () => {
  const budget = createVerificationBudget()
  budget.reset({ startedAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 360_000 })
  let nestedSignal: AbortSignal | undefined
  const batch = createVerificationBatchTool({
    verificationBudget: budget,
    authorizeVerificationCommand: async (_args, signal) => {
      nestedSignal = signal
      return new Promise(() => {})
    },
  })
  const result = decode(
    await batch.handler({
      max_duration_ms: 20,
      commands: [{ label: "waiting", command: "echo never" }],
    })
  )
  assert.equal(nestedSignal?.aborted, true)
  assert.equal(result.status, "incomplete")
  assert.deepEqual(result.pending, ["waiting"])
})

test("a changed turn during approval prevents execution", async () => {
  const f = fixture()
  const batch = createVerificationBatchTool({
    verificationBudget: f.budget,
    authorizeVerificationCommand: async (args) => {
      f.budget.reset(undefined)
      return args
    },
  })
  const result = decode(
    await batch.handler({ commands: [{ label: "stale", command: "echo never" }] })
  )
  assert.deepEqual(result.pending, ["stale"])
  assert.equal(result.results.length, 0)
})

test("running foreground work is terminated and later checks remain pending", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "verification-timeout-"))
  const budget = createVerificationBudget()
  budget.reset({ startedAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 360_000 })
  try {
    const batch = createVerificationBatchTool({
      cwd: directory,
      verificationBudget: budget,
      authorizeVerificationCommand: async (args) => args,
    })
    const result = decode(
      await batch.handler({
        max_duration_ms: 150,
        commands: [
          { label: "slow", command: "sleep 10; echo escaped > escaped" },
          { label: "later", command: "echo bad > later" },
        ],
      })
    )
    assert.equal(result.status, "incomplete")
    assert.deepEqual(result.pending, ["later"])
    assert.equal(result.results[0].status, "failed")
    await assert.rejects(fs.access(path.join(directory, "escaped")))
    await assert.rejects(fs.access(path.join(directory, "later")))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("approval cannot substitute a different command or working directory", async () => {
  for (const change of [{ command: "echo changed" }, { workdir: "/tmp/changed" }]) {
    const f = fixture()
    const batch = createVerificationBatchTool({
      verificationBudget: f.budget,
      authorizeVerificationCommand: async (args) => ({ ...(args as object), ...change }),
    })
    const result = decode(
      await batch.handler({ commands: [{ label: "original", command: "echo original" }] })
    )
    assert.equal(result.status, "incomplete")
    assert.match(result.results[0].reason, /require a new verification batch/)
    assert.deepEqual(result.pending, ["original"])
  }
})

test("unchanged approved workdir is rechecked after a symlink changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "verification-scope-"))
  const safe = path.join(directory, "safe"),
    secret = path.join(directory, ".ssh"),
    alias = path.join(directory, "alias")
  await fs.mkdir(safe)
  await fs.mkdir(secret)
  await fs.symlink(safe, alias)
  try {
    const f = fixture()
    const batch = createVerificationBatchTool({
      cwd: directory,
      verificationBudget: f.budget,
      builtinProcessSandbox: { writableRoots: [directory] },
      authorizeVerificationCommand: async (args) => {
        await fs.unlink(alias)
        await fs.symlink(secret, alias)
        return args
      },
    })
    const result = decode(
      await batch.handler({
        commands: [{ label: "check", command: "echo never > marker", workdir: alias }],
      })
    )
    assert.deepEqual(result.pending, ["check"])
    assert.match(result.results[0].reason, /workspace sandbox refused/)
    await assert.rejects(fs.access(path.join(secret, "marker")))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
