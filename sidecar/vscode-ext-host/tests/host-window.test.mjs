// `vscode.window` through the real host: the test plays the renderer,
// answering the host's requests and sending the user's actions back.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.window-extension"
const PATH = join(FIXTURES, "window-extension")

async function until(check, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startWindow() {
  const commands = new Map()
  const requests = []
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "window:showMessage") return 0
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
  const event = (sessionId, payload) =>
    host.request("window:quickInputEvent", { sessionId, event: payload })
  const request = (method) => until(() => requests.find((entry) => entry.method === method), method)
  const notifications = (method) => host.notifications.filter((frame) => frame.method === method)
  return { host, run, event, request, requests, notifications }
}

test("quick pick: shown busy at once, filled when the items arrive, answers with the extension's item", async () => {
  const { host, run, event, request, notifications } = await startWindow()
  try {
    const picked = run("windowFixture.pick")
    const open = await request("window:quickInputOpen")
    assert.equal(open.params.kind, "pick")
    assert.equal(open.params.state.busy, true)
    assert.equal(open.params.state.placeholder, "Pick one")
    assert.equal(open.params.state.title, "Fixture")
    const update = await until(
      () => notifications("window:quickInputUpdate").find((frame) => frame.params.state.items),
      "items"
    )
    assert.deepEqual(update.params.state.items, [
      { label: "a" },
      { label: "b", description: "second" },
    ])
    assert.equal(update.params.state.busy, false)
    await event(open.params.sessionId, { type: "accept", selected: [1] })
    assert.deepEqual(await picked, { label: "b", description: "second" })
    await until(() => notifications("window:quickInputClose").length === 1, "close")
  } finally {
    host.stop()
  }
})

test("multi pick returns the selected strings; a dismissal returns nothing", async () => {
  const { host, run, event, request, requests } = await startWindow()
  try {
    const many = run("windowFixture.pickMany")
    const open = await request("window:quickInputOpen")
    await event(open.params.sessionId, { type: "selection", indices: [0, 2] })
    await event(open.params.sessionId, { type: "accept" })
    assert.deepEqual(await many, ["x", "z"])

    const dismissed = run("windowFixture.pick")
    const second = await until(
      () => requests.filter((entry) => entry.method === "window:quickInputOpen")[1],
      "second open"
    )
    await event(second.params.sessionId, { type: "hide" })
    assert.equal(await dismissed, null)
  } finally {
    host.stop()
  }
})

test("input box: validation blocks accepting until the value passes", async () => {
  const { host, run, event, request, notifications } = await startWindow()
  try {
    const entered = run("windowFixture.input")
    const open = await request("window:quickInputOpen")
    assert.equal(open.params.kind, "input")
    assert.equal(open.params.state.value, "ab")
    assert.equal(open.params.state.prompt, "Name")
    await event(open.params.sessionId, { type: "accept" })
    await until(
      () =>
        notifications("window:quickInputUpdate").find(
          (frame) => frame.params.state.validationMessage?.message === "too short"
        ),
      "validation message"
    )
    assert.deepEqual(
      notifications("window:quickInputUpdate").find((frame) => frame.params.state.validationMessage)
        .params.state.validationMessage,
      { message: "too short", severity: 3 }
    )
    await event(open.params.sessionId, { type: "value", value: "abcd" })
    await event(open.params.sessionId, { type: "accept" })
    assert.equal(await entered, "abcd")
  } finally {
    host.stop()
  }
})

test("a modal message returns the chosen item object", async () => {
  const { host, run, request } = await startWindow()
  try {
    assert.deepEqual(await run("windowFixture.message"), { title: "Yes" })
    const shown = await request("window:showMessage")
    assert.deepEqual(shown.params, {
      extensionId: ID,
      severity: "warning",
      message: "Proceed?",
      detail: "It cannot be undone",
      modal: true,
      items: [{ title: "Yes" }, { title: "No", isCloseAffordance: true }],
    })
  } finally {
    host.stop()
  }
})

test("progress reports, and the renderer's cancel reaches the task's token", async () => {
  const { host, run, request, notifications } = await startWindow()
  try {
    const result = run("windowFixture.progress")
    const start = await request("window:progressStart")
    assert.deepEqual(start.params, {
      extensionId: ID,
      handle: start.params.handle,
      location: "notification",
      title: "Work",
      cancellable: true,
    })
    await until(() => notifications("window:progressReport").length === 1, "report")
    assert.deepEqual(notifications("window:progressReport")[0].params, {
      handle: start.params.handle,
      message: "started",
      increment: 10,
    })
    await host.request("window:progressCancel", { handle: start.params.handle })
    assert.equal(await result, "cancelled")
    await until(() => notifications("window:progressEnd").length === 1, "end")
  } finally {
    host.stop()
  }
})

test("status bar items report their whole state; status messages clear themselves", async () => {
  const { host, run, notifications } = await startWindow()
  try {
    assert.deepEqual(await run("windowFixture.status"), {
      id: "fixture.status",
      alignment: 2,
      priority: 5,
    })
    const item = await until(() => notifications("window:statusBarItem").at(-1), "item")
    assert.deepEqual(item.params.state, {
      id: "fixture.status",
      alignment: 2,
      priority: 5,
      visible: true,
      text: "$(check) Ready",
      tooltip: "All **good**",
      command: { command: "windowFixture.pick", arguments: [1] },
    })
    assert.equal(
      notifications("window:statusBarItem").length,
      1,
      "changes in one tick are sent once"
    )
    const message = notifications("window:setStatusBarMessage")[0]
    assert.equal(message.params.text, "Saved")
    await until(() => notifications("window:clearStatusBarMessage").length === 1, "clear")
    assert.equal(
      notifications("window:clearStatusBarMessage")[0].params.handle,
      message.params.handle
    )
  } finally {
    host.stop()
  }
})

test("log output channels respect the level; a stray rejection does not kill the host", async () => {
  const { host, run, notifications } = await startWindow()
  try {
    assert.equal(await run("windowFixture.log"), 3)
    const writes = await until(() => {
      const frames = notifications("window:outputChannel")
      return frames.length >= 2 ? frames : null
    }, "output")
    assert.deepEqual(
      writes.map((frame) => [frame.params.op, frame.params.level, frame.params.value]),
      [
        ["log", "info", 'hello {"a":1}'],
        ["append", undefined, "plain line\n"],
      ]
    )
    assert.equal(await run("windowFixture.reject"), "returned")
    await until(
      () => host.stderr.some((line) => line.includes("Unhandled rejection")),
      "logged rejection"
    )
    assert.equal(await run("windowFixture.log"), 3, "the host still answers")
  } finally {
    host.stop()
  }
})
