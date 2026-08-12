import assert from "node:assert/strict"
import test from "node:test"

import { ensureCodexCdpRuntime } from "./cdp-runtime.mjs"

function readyFixture({ initiallyReady = false } = {}) {
  let running = true
  let cdpReady = initiallyReady
  const commands = []
  const statuses = []

  return {
    commands,
    statuses,
    dependencies: {
      appProcessIds: () => (running ? [101] : []),
      commandResult: (command, args) => {
        commands.push([command, ...args])
        if (command === "/usr/bin/osascript") running = false
        if (command === "/usr/bin/open") {
          running = true
          cdpReady = args.some((argument) => argument === "--remote-debugging-port=9229")
        }
        return { ok: true, stdout: "", stderr: "", error: null }
      },
      discoverCodexRenderer: async () =>
        cdpReady
          ? {
              id: "codex-renderer",
              url: "app://-/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/codex",
            }
          : null,
      inspectTcpListener: () => ({
        listening: cdpReady,
        loopbackOnly: cdpReady,
        addresses: cdpReady ? ["127.0.0.1:9229"] : [],
      }),
      normalAppServerChildren: () =>
        cdpReady ? [{ pid: 202, ppid: 101, command: "codex app-server" }] : [],
      relaunchCdpApp: async () => {
        commands.push([
          "/usr/bin/osascript",
          "-e",
          'tell application id "com.openai.codex" to quit',
        ])
        running = false
        commands.push([
          "/usr/bin/open",
          "--new",
          "/Applications/ChatGPT.app",
          "--args",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=9229",
        ])
        running = true
        cdpReady = true
        return { status: "ready", attemptId: "test-attempt" }
      },
      waitFor: async (predicate, options) => {
        const value = await predicate()
        if (!value) throw new Error(`${options.description} timed out in test`)
        return value
      },
    },
    onStatus: (status) => statuses.push(status),
  }
}

test("missing CDP automatically restarts the App and gates on the real renderer", async () => {
  const fixture = readyFixture()

  const result = await ensureCodexCdpRuntime(
    {
      cdpPort: 9229,
      appPath: "/Applications/ChatGPT.app",
      realCli: "/Applications/ChatGPT.app/Contents/Resources/codex",
      onStatus: fixture.onStatus,
    },
    fixture.dependencies
  )

  assert.equal(result.ready, true)
  assert.equal(result.restarted, true)
  assert.equal(result.renderer.id, "codex-renderer")
  assert.equal(result.appServerChildren.length, 1)
  assert.deepEqual(fixture.statuses, [
    "checking",
    "restart-required",
    "restart-armed",
    "waiting-for-runtime",
    "ready",
  ])
  assert.deepEqual(fixture.commands[0].slice(0, 2), ["/usr/bin/osascript", "-e"])
  assert.deepEqual(fixture.commands[1], [
    "/usr/bin/open",
    "--new",
    "/Applications/ChatGPT.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9229",
  ])
})

test("a healthy loopback renderer is reused without restarting the App", async () => {
  const fixture = readyFixture({ initiallyReady: true })

  const result = await ensureCodexCdpRuntime(
    { cdpPort: 9229, onStatus: fixture.onStatus },
    fixture.dependencies
  )

  assert.equal(result.ready, true)
  assert.equal(result.restarted, false)
  assert.deepEqual(fixture.commands, [])
  assert.deepEqual(fixture.statuses, ["checking", "ready"])
})

test("an occupied CDP port without a Codex renderer fails closed", async () => {
  const fixture = readyFixture()
  fixture.dependencies.inspectTcpListener = () => ({
    listening: true,
    loopbackOnly: true,
    addresses: ["127.0.0.1:9229"],
  })

  await assert.rejects(
    ensureCodexCdpRuntime({ cdpPort: 9229 }, fixture.dependencies),
    /occupied but does not expose a Codex renderer/
  )
  assert.deepEqual(fixture.commands, [])
})

test("a detached relaunch failure is surfaced after the worker rollback", async () => {
  const fixture = readyFixture()
  fixture.dependencies.relaunchCdpApp = async () => {
    throw new Error("renderer readiness timed out; Codex App was restored without CDP")
  }

  await assert.rejects(
    ensureCodexCdpRuntime(
      {
        cdpPort: 9229,
        appPath: "/Applications/ChatGPT.app",
        onStatus: fixture.onStatus,
      },
      fixture.dependencies
    ),
    /renderer readiness timed out; Codex App was restored without CDP/
  )
  assert.equal(fixture.statuses.at(-1), "recovery-failed")
})
