// `window.createTerminal` and the terminal events through the real host: the
// test plays the renderer's dock, answering creates and reporting what the
// user and the terminals did.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.terminal-extension"
const PATH = join(FIXTURES, "terminal-extension")

async function until(check, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startTerminals(answer = () => undefined) {
  const commands = new Map()
  const requests = []
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "terminal:create") {
      const answered = answer(method, params)
      if (answered !== undefined) return answered
      return params.kind === "pty"
        ? { dimensions: { columns: 80, rows: 24 } }
        : { name: params.name ?? "zsh" }
    }
    return answer(method, params) ?? null
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
  const sent = (method) => requests.filter((entry) => entry.method === method)
  const report = (method, params) => host.request(method, params)
  return { host, run, sent, report }
}

test("a process terminal: created as asked, typed into in order, shown, hidden", async () => {
  const { host, run, sent } = await startTerminals()
  try {
    assert.deepEqual(await run("terminalFixture.process"), {
      name: "Build",
      own: ["Build"],
      noShellIntegration: true,
    })
    const [create] = sent("terminal:create")
    assert.equal(create.params.extensionId, ID)
    assert.match(create.params.terminalId, /^term:/)
    assert.deepEqual(
      { ...create.params, terminalId: undefined, extensionId: undefined },
      {
        terminalId: undefined,
        extensionId: undefined,
        kind: "process",
        name: "Build",
        shellPath: "/bin/sh",
        shellArgs: ["-l"],
        cwd: "/tmp/work",
        env: { A: "1" },
        unsetEnv: ["B"],
        color: "terminal.ansiRed",
      }
    )
    await until(() => sent("terminal:hide").length === 1, "hide")
    assert.deepEqual(
      sent("terminal:sendText").map((entry) => entry.params.data),
      ["echo hi\r", "a\rb"]
    )
    assert.equal(sent("terminal:show")[0].params.preserveFocus, true)
    const order = sent("terminal:create")
      .concat(sent("terminal:sendText"), sent("terminal:show"), sent("terminal:hide"))
      .map((entry) => entry.method)
    assert.deepEqual(order, [
      "terminal:create",
      "terminal:sendText",
      "terminal:sendText",
      "terminal:show",
      "terminal:hide",
    ])
  } finally {
    host.stop()
  }
})

test("the legacy signature and an unnamed terminal take their names", async () => {
  const { host, run, sent } = await startTerminals()
  try {
    assert.deepEqual(await run("terminalFixture.legacy"), { name: "Named", noProcessId: true })
    assert.deepEqual(sent("terminal:create")[0].params.shellArgs, ["-c", "true"])
    assert.equal(await run("terminalFixture.unnamed"), "zsh")
  } finally {
    host.stop()
  }
})

test("events: open with thisArgs, active, interaction, and close with how it ended", async () => {
  const { host, run, sent, report } = await startTerminals()
  try {
    await run("terminalFixture.process")
    const terminalId = sent("terminal:create")[0].params.terminalId
    await report("terminal:activeChanged", { terminalId })
    await report("terminal:activeChanged", { terminalId })
    await report("terminal:interacted", { terminalId })
    await report("terminal:activeChanged", { terminalId: null })
    let state = await run("terminalFixture.state")
    assert.equal(state.build.interacted, true)
    await run("terminalFixture.dispose")
    await until(() => sent("terminal:dispose").length === 1, "dispose")
    await report("terminal:closed", { terminalId, code: 0, reason: 4 })
    await report("terminal:closed", { terminalId, code: 9, reason: 2 })
    state = await run("terminalFixture.state")
    assert.deepEqual(state.events, [
      { event: "open", name: "Build", self: "listener" },
      { event: "active", name: "Build" },
      { event: "state", name: "Build", interacted: true },
      { event: "active", name: null },
      { event: "close", name: "Build", exitStatus: { code: 0, reason: 4 } },
    ])
    assert.deepEqual(state.build.exitStatus, { code: 0, reason: 4 })
    assert.deepEqual(state.terminals, [])
    assert.deepEqual(state.enums, [4, 1])
  } finally {
    host.stop()
  }
})

test("a refused terminal closes at once, for an unknown reason", async () => {
  const { host, run } = await startTerminals((method) => {
    if (method === "terminal:create") throw new Error("requires permission terminal:spawn")
    return undefined
  })
  try {
    await run("terminalFixture.process")
    let state = await run("terminalFixture.state")
    for (let attempt = 0; attempt < 100 && !state.build.exitStatus; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      state = await run("terminalFixture.state")
    }
    // JSON drops the undefined code.
    assert.deepEqual(state.build.exitStatus, { reason: 0 })
  } finally {
    host.stop()
  }
})

test("an extension terminal: opened at the tab's size, fed both ways, renamed, closed", async () => {
  const { host, run, sent, report } = await startTerminals()
  try {
    assert.deepEqual(await run("terminalFixture.pty"), { name: "REPL", noProcessId: true })
    const create = sent("terminal:create")[0]
    assert.deepEqual(
      { kind: create.params.kind, name: create.params.name },
      { kind: "pty", name: "REPL" }
    )
    const terminalId = create.params.terminalId
    await until(() => sent("terminal:ptyWrite").length === 1, "first write")
    assert.equal(sent("terminal:ptyWrite")[0].params.data, "ready> ")
    await report("terminal:ptyInput", { terminalId, data: "2+2\r" })
    await report("terminal:ptyResize", { terminalId, columns: 120, rows: 40 })
    assert.equal(await run("terminalFixture.ptyRename"), "REPL (busy)")
    await until(() => sent("terminal:rename").length === 1, "rename")
    assert.equal(sent("terminal:rename")[0].params.name, "REPL (busy)")
    let state = await run("terminalFixture.state")
    assert.deepEqual(state.record.dimensions, [
      { columns: 80, rows: 24 },
      { columns: 120, rows: 40 },
    ])
    // sendText is the extension terminal's own input, not a renderer write.
    assert.deepEqual(state.record.input, ["1+1\r", "2+2\r"])
    assert.equal(sent("terminal:sendText").length, 0)
    await run("terminalFixture.ptyClose")
    await until(() => sent("terminal:ptyClose").length === 1, "pty close")
    assert.equal(sent("terminal:ptyClose")[0].params.code, 3)
    await report("terminal:closed", { terminalId, code: 3, reason: 2 })
    state = await run("terminalFixture.state")
    assert.deepEqual(state.pty.exitStatus, { code: 3, reason: 2 })
    // It closed itself: close() is not called back.
    assert.equal(state.record.closes, 0)
  } finally {
    host.stop()
  }
})

test("the user closing an extension terminal calls its close()", async () => {
  const { host, run, sent, report } = await startTerminals()
  try {
    await run("terminalFixture.pty")
    const terminalId = sent("terminal:create")[0].params.terminalId
    await report("terminal:closed", { terminalId, reason: 3 })
    const state = await run("terminalFixture.state")
    assert.equal(state.record.closes, 1)
    assert.deepEqual(state.pty.exitStatus, { reason: 3 })
  } finally {
    host.stop()
  }
})
