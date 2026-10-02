import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createEditorVerbs } from "../src/editor-verbs.mjs"
import {
  TEST_PROBE_ENV,
  createProbeRecorder,
  createTestProbe,
  MAX_PROBE_EVENTS,
  plainResult,
  testProbeEnabled,
} from "../src/test-probe.mjs"

/** VS Code's MarkdownString: its text sits behind a private field. */
class MarkdownString {
  #value
  constructor(value) {
    this.#value = value
  }
  get value() {
    return this.#value
  }
  appendMarkdown(text) {
    this.#value += text
    return this
  }
}

const fakeVscode = (commands = {}) => ({
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
    dispose() {}
  },
  Uri: { parse: (value) => ({ scheme: value.split(":")[0], path: value, toString: () => value }) },
  Position: class {
    constructor(line, character) {
      Object.assign(this, { line, character })
    }
  },
  commands: {
    executeCommand: async (command, ...args) => commands[command]?.(...args),
  },
})

describe("off unless the E2E asked for it", () => {
  test("only an explicit 1 enables it", () => {
    assert.equal(testProbeEnabled({}), false)
    assert.equal(testProbeEnabled({ [TEST_PROBE_ENV]: "true" }), false)
    assert.equal(testProbeEnabled({ [TEST_PROBE_ENV]: "1" }), true)
  })

  test("off, there is no verb and nothing is recorded", async () => {
    const recorder = createProbeRecorder(false)
    assert.equal(createTestProbe(fakeVscode(), recorder), null)
    recorder.track("sourceControl", "x", {})
    recorder.record("testRun", { controllerId: "x" })
    assert.equal(recorder.tracked("sourceControl", "x"), undefined)
    assert.equal(recorder.size, 0)

    const { dispatch } = createEditorVerbs(fakeVscode(), {
      onSnapshot() {},
      getProxyRegistration() {},
      testProbe: createTestProbe(fakeVscode(), recorder),
    })
    await assert.rejects(dispatch("testProbe", { action: "scm" }), /unknown method: testProbe/)
    // `ping` exists either way: the latency gate measures it in production builds.
    assert.deepEqual(await dispatch("ping", {}), {})
  })
})

describe("on", () => {
  test("runs allowlisted commands with revived arguments and plain results", async () => {
    const vscode = fakeVscode({
      "vscode.executeCodeLensProvider": (uri) => [
        { range: { start: { line: 0, character: 0 } }, command: { title: `lens for ${uri.path}` } },
      ],
    })
    const probe = createTestProbe(vscode, createProbeRecorder(true))
    const lenses = await probe({
      action: "command",
      command: "vscode.executeCodeLensProvider",
      args: [{ $uri: "file:///work/a.ts" }],
    })
    assert.equal(lenses[0].command.title, "lens for file:///work/a.ts")
  })

  test("opens the file first when asked, before running the command", async () => {
    const order = []
    const vscode = fakeVscode({ "vscode.executeHoverProvider": () => order.push("command") && [] })
    vscode.Uri.file = (path) => ({ scheme: "file", path })
    vscode.workspace = {
      openTextDocument: async (uri) => (order.push(`open ${uri.path}`), { uri }),
    }
    vscode.window = { showTextDocument: async () => order.push("show") }
    const probe = createTestProbe(vscode, createProbeRecorder(true))
    await probe({ action: "command", command: "vscode.executeHoverProvider", open: "/work/a.cfx" })
    assert.deepEqual(order, ["open /work/a.cfx", "show", "command"])
  })

  test("refuses a command outside the allowlist and an unknown action", async () => {
    const probe = createTestProbe(fakeVscode(), createProbeRecorder(true))
    await assert.rejects(
      probe({ action: "command", command: "workbench.action.terminal.sendSequence" }),
      /TEST_PROBE_COMMAND_REFUSED/
    )
    await assert.rejects(probe({ action: "toString" }), /TEST_PROBE_UNKNOWN_ACTION/)
  })

  test("reports a source control's groups as VS Code holds them", async () => {
    const recorder = createProbeRecorder(true)
    const groups = new Map([
      [
        "changes",
        {
          id: "changes",
          label: "Changes",
          resourceStates: [{ resourceUri: { toString: () => "file:///w/a" } }],
        },
      ],
    ])
    recorder.track("sourceControl", "cognia.acme.scm", { scm: { label: "Acme", count: 1 }, groups })
    const probe = createTestProbe(fakeVscode(), recorder)
    assert.deepEqual(await probe({ action: "scm", id: "cognia.acme.scm" }), {
      label: "Acme",
      count: 1,
      groups: [{ id: "changes", label: "Changes", resources: ["file:///w/a"] }],
    })
  })

  test("waits for the test run the command started", async () => {
    const recorder = createProbeRecorder(true)
    const vscode = fakeVscode({
      "testing.runAll": () =>
        setTimeout(() => recorder.record("testRun", { controllerId: "c1", settled: ["t1"] }), 5),
    })
    const probe = createTestProbe(vscode, recorder)
    const run = await probe({ action: "runTests", controllerId: "c1" })
    assert.deepEqual(run.settled, ["t1"])
  })
})

test("plainResult keeps URIs, markdown and ranges legible", () => {
  const uri = { scheme: "file", path: "/a", toString: () => "file:///a" }
  assert.deepEqual(plainResult({ uri, contents: [{ value: "**hi**", isTrusted: false }] }), {
    uri: "file:///a",
    contents: ["**hi**"],
  })
})

test("a hover's MarkdownString comes out as its text", () => {
  assert.deepEqual(plainResult([{ contents: [new MarkdownString("**hi**")] }]), [
    { contents: ["**hi**"] },
  ])
})

test("emitEvents sends a numbered burst, bounded, and needs an emitter", async () => {
  const sent = []
  const probe = createTestProbe(fakeVscode(), createProbeRecorder(true), {
    emit: (name, payload) => (sent.push([name, payload.seq]), true),
  })
  assert.deepEqual(await probe({ action: "emitEvents", count: 3 }), { sent: 3 })
  assert.deepEqual(sent, [
    ["testProbeEvent", 0],
    ["testProbeEvent", 1],
    ["testProbeEvent", 2],
  ])
  sent.length = 0
  assert.deepEqual(await probe({ action: "emitEvents", count: 1e9 }), { sent: MAX_PROBE_EVENTS })
  assert.deepEqual(await probe({ action: "emitEvents", count: -4 }), { sent: 0 })
  const unwired = createTestProbe(fakeVscode(), createProbeRecorder(true))
  await assert.rejects(unwired({ action: "emitEvents", count: 1 }), /TEST_PROBE_UNAVAILABLE/)
})
