import assert from "node:assert/strict"
import test from "node:test"

import {
  configDir,
  agentDebugEnvironment,
  AGENT_DEBUG_TAURI_CONFIG,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  endpointFilePath,
  launchTimeout,
  parseArgs,
  parseEndpoint,
  tauriDevArgs,
} from "./agent-debug.mjs"

test("allows a Cognia cold native build to finish by default", () => {
  assert.equal(launchTimeout(), DEFAULT_LAUNCH_TIMEOUT_MS)
  assert.equal(DEFAULT_LAUNCH_TIMEOUT_MS, 1_200_000)
  assert.equal(launchTimeout("120000"), 120_000)
  assert.throws(() => launchTimeout("soon"), /positive number/)
})

test("launch uses the lean agent-debug config and checkout runtimes", () => {
  assert.deepEqual(tauriDevArgs(), [
    "tauri",
    "dev",
    "--features",
    "agent-debug",
    "--config",
    AGENT_DEBUG_TAURI_CONFIG,
  ])
  const environment = agentDebugEnvironment({ PATH: "/bin" }, "/repo")
  assert.equal(environment.COGNIA_AGENT_DEBUG, "1")
  assert.match(
    environment.COGNIA_PLUGIN_NODE_PATH,
    /src-tauri\/resources\/plugin-node\/bin\/node(?:\.exe)?$/
  )
  assert.equal(environment.COGNIA_MCP_SIDECAR_PATH, "/repo/sidecar/cognia-mcp.mjs")
})

test("resolves the Rust directories config path on every desktop platform", () => {
  assert.equal(configDir("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support")
  assert.equal(configDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/test"), "/cfg")
  assert.equal(
    configDir("win32", { APPDATA: "C:\\Users\\test\\Roaming" }, "C:\\Users\\test"),
    "C:\\Users\\test\\Roaming"
  )
  assert.equal(
    endpointFilePath("linux", { COGNIA_CLI_ENDPOINT_FILE: "/tmp/custom.json" }, "/home/test"),
    "/tmp/custom.json"
  )
})

test("accepts only loopback endpoint discovery payloads with a session token", () => {
  assert.deepEqual(
    parseEndpoint(JSON.stringify({ baseUrl: "http://127.0.0.1:4317", devToken: "a".repeat(64) })),
    {
      baseUrl: "http://127.0.0.1:4317",
      devToken: "a".repeat(64),
    }
  )
  assert.equal(
    parseEndpoint(JSON.stringify({ baseUrl: "http://0.0.0.0:4317", devToken: "a".repeat(64) })),
    null
  )
  assert.equal(parseEndpoint("not-json"), null)
})

test("parses positional action arguments and boolean flags", () => {
  assert.deepEqual(
    parseArgs(["act", "g2e3", "fill", "hello", "--window", "main", "--include-text"]),
    {
      command: "act",
      positional: ["g2e3", "fill", "hello"],
      options: { window: "main", "include-text": true },
    }
  )
  assert.throws(() => parseArgs(["snapshot", "--window"]), /missing value/)
})
