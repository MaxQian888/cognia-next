import assert from "node:assert/strict"
import test from "node:test"

import {
  buildAppServerEnvironment,
  buildCdpOnlyAppOpenArgs,
  buildDaemonAppOpenArgs,
  buildRelayOpenArgs,
} from "./launch-config.mjs"

test("buildRelayOpenArgs enables loopback CDP only when explicitly configured", () => {
  const args = buildRelayOpenArgs({
    appPath: "/Applications/ChatGPT.app",
    cdpPort: 9229,
    nodeDirectory: "/opt/node/bin",
    port: 4318,
    realCli: "/Applications/ChatGPT.app/Contents/Resources/codex",
    shim: "/tmp/relay-shim.mjs",
    stateDir: "/tmp/cognia-relay",
    workspace: "/Users/example/project",
  })

  assert.deepEqual(args.slice(-3), [
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9229",
  ])
  assert.ok(args.includes("CODEX_RELAY_CDP_PORT=9229"))
  assert.ok(args.includes("CODEX_CLI_PATH=/tmp/relay-shim.mjs"))
})

test("buildRelayOpenArgs keeps normal relay launches free of CDP switches", () => {
  const args = buildRelayOpenArgs({
    appPath: "/Applications/ChatGPT.app",
    cdpPort: null,
    nodeDirectory: "/opt/node/bin",
    port: 4318,
    realCli: "/Applications/ChatGPT.app/Contents/Resources/codex",
    shim: "/tmp/relay-shim.mjs",
    stateDir: "/tmp/cognia-relay",
    workspace: "/Users/example/project",
  })

  assert.equal(
    args.some((argument) => argument.includes("remote-debugging")),
    false
  )
  assert.equal(
    args.some((argument) => argument.startsWith("CODEX_RELAY_CDP_PORT=")),
    false
  )
})

test("the real App Server does not inherit relay-only launch variables", () => {
  const environment = buildAppServerEnvironment({
    PATH: "/usr/bin:/bin",
    CODEX_CLI_PATH: "/tmp/relay-shim.mjs",
    CODEX_RELAY_PORT: "4324",
    CODEX_RELAY_CDP_PORT: "9233",
    CODEX_RELAY_WORKSPACE: "/tmp/workspace",
    KEEP_ME: "preserved",
  })

  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    KEEP_ME: "preserved",
  })
})

test("daemon App launch selects the UDS runtime without CLI overrides", () => {
  const args = buildDaemonAppOpenArgs({
    appPath: "/Applications/ChatGPT.app",
    nodeDirectory: "/opt/node/bin",
  })

  assert.ok(args.includes("CODEX_APP_SERVER_USE_LOCAL_DAEMON=1"))
  assert.ok(args.includes("CODEX_APP_SERVER_FORCE_CLI="))
  assert.ok(args.includes("CODEX_CLI_PATH="))
  assert.equal(args.at(-1), "/Applications/ChatGPT.app")
})

test("CDP-only App launch preserves the normal bundled runtime", () => {
  const args = buildCdpOnlyAppOpenArgs({
    appPath: "/Applications/ChatGPT.app",
    cdpPort: 9229,
  })

  assert.deepEqual(args, [
    "--new",
    "/Applications/ChatGPT.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9229",
  ])
  assert.equal(
    args.some((argument) => argument.includes("CODEX_CLI_PATH")),
    false
  )
  assert.equal(
    args.some((argument) => argument.includes("CODEX_APP_SERVER")),
    false
  )
})
