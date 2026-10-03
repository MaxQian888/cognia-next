// `vscode.tasks` through the real host: providers through the renderer's
// registry, and tasks run in dock terminals the test plays.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.tasks-extension"
const PATH = join(FIXTURES, "tasks-extension")

async function until(check, what) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startTasks({ refuseTerminals = false } = {}) {
  const commands = new Map()
  const requests = []
  const providers = new Map()
  let host
  host = startHost(ID, async (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "tasks:registerProvider") {
      providers.set(params.type, params.tokens.provideTasks)
      return { registered: true }
    }
    if (method === "tasks:fetchTasks") {
      // As the renderer's registry does: ask every provider.
      const lists = await Promise.all(
        [...providers].map(([type, token]) =>
          host.request("extension:call", {
            extensionId: ID,
            token,
            method: "provideTasks",
            payload: { filter: { type } },
          })
        )
      )
      return lists.flat()
    }
    if (method === "terminal:create") {
      if (refuseTerminals)
        throw new Error(
          "VS Code extension cognia.tasks-extension requires permission terminal:spawn"
        )
      return params.kind === "pty"
        ? { dimensions: { columns: 80, rows: 24 } }
        : { name: params.name }
    }
    return null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: [] })
  const created = () => requests.filter((entry) => entry.method === "terminal:create")
  return { host, run, requests, created }
}

test("fetchTasks goes through the registry and gives back the provider's own tasks", async () => {
  const { host, run, requests } = await startTasks()
  try {
    assert.deepEqual(await run("tasksFixture.fetch"), [
      { name: "build", same: true, group: "build", commandLine: "make" },
    ])
    const registered = requests.find((entry) => entry.method === "tasks:registerProvider")
    assert.equal(registered.params.type, "fixture")
  } finally {
    host.stop()
  }
})

test("a shell task runs in a dock terminal, and its end carries the exit code", async () => {
  const { host, run, created, requests } = await startTasks()
  try {
    assert.deepEqual(await run("tasksFixture.run"), { running: 1, same: true })
    const [terminal] = created()
    assert.equal(terminal.params.kind, "process")
    assert.equal(terminal.params.name, "fixture: build")
    assert.equal(terminal.params.cwd, "/tmp")
    assert.deepEqual(terminal.params.shellArgs.slice(-1), ["make all 'two words'"])
    // Revealed by default, without taking focus.
    const show = await until(
      () => requests.find((entry) => entry.method === "terminal:show"),
      "show"
    )
    assert.equal(show.params.preserveFocus, true)

    await host.request("terminal:closed", {
      terminalId: terminal.params.terminalId,
      code: 2,
      reason: 2,
    })
    const { events, running } = await until(async () => {
      const seen = await run("tasksFixture.events")
      return seen.events.some((event) => event.kind === "end") && seen
    }, "the end")
    assert.equal(running, 0)
    assert.deepEqual(events, [
      { kind: "start", task: "build" },
      { kind: "startProcess", task: "build" },
      { kind: "endProcess", task: "build", exitCode: 2 },
      { kind: "end", task: "build" },
    ])
  } finally {
    host.stop()
  }
})

test("a task without an execution is resolved by the extension's provider first", async () => {
  const { host, run, created } = await startTasks()
  try {
    assert.deepEqual(await run("tasksFixture.runLazy"), { process: "node" })
    const [terminal] = created()
    assert.equal(terminal.params.shellPath, "node")
    assert.deepEqual(terminal.params.shellArgs, ["-v"])
  } finally {
    host.stop()
  }
})

test("terminate closes the task's terminal", async () => {
  const { host, run, requests } = await startTasks()
  try {
    await run("tasksFixture.run")
    await run("tasksFixture.terminate")
    await until(() => requests.find((entry) => entry.method === "terminal:dispose"), "the dispose")
  } finally {
    host.stop()
  }
})

test("a custom task runs the extension's Pseudoterminal and ends when it closes", async () => {
  const { host, run, created, requests } = await startTasks()
  try {
    await run("tasksFixture.custom")
    const [terminal] = created()
    assert.equal(terminal.params.kind, "pty")
    // The renderer hears the Pseudoterminal close, and reports the terminal closed.
    const close = await until(
      () => requests.find((entry) => entry.method === "terminal:ptyClose"),
      "the close"
    )
    assert.equal(close.params.code, 3)
    await host.request("terminal:closed", {
      terminalId: terminal.params.terminalId,
      code: 3,
      reason: 2,
    })
    const { events } = await until(async () => {
      const seen = await run("tasksFixture.events")
      return seen.events.some((event) => event.kind === "end") && seen
    }, "the end")
    // No process events for a custom execution.
    assert.deepEqual(
      events.map((event) => event.kind),
      ["start", "end"]
    )
  } finally {
    host.stop()
  }
})

test("a task that cannot get a terminal fails to start", async () => {
  const { host, run } = await startTasks({ refuseTerminals: true })
  try {
    await assert.rejects(run("tasksFixture.run"), /requires permission terminal:spawn/)
    assert.deepEqual((await run("tasksFixture.events")).events, [])
  } finally {
    host.stop()
  }
})
